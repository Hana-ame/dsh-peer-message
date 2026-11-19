// pm-registry — peer-message 注册与链接辅助服务
//
// 定位：PeerJS 云端的旁路补充，不替换信令。解决两件事：
//   1) presence：好友在不在线有权威来源，不再靠「发消息时试连」或 reconnectAll 盲拨；
//   2) 链接辅助：上报/查询 peerId → {fingerprint, token 提示, 首见/末见时间, 来源}，
//      便于跨机器/容器配对、调试「找不到人」。
//
// 安全姿态：
//   - 只监听 loopback（默认 127.0.0.1:9600）或 unix socket；要暴露到 LAN 必须显式 -listen；
//   - 所有写入端点要求共享密钥（-auth，或 PM_REGISTRY_AUTH 环境变量），
//     daemon 与 registry 用同一密钥，防止本机其它进程伪造注册；
//   - 不存私钥、不转发消息正文；只存注册元数据（内存 + 可选 -state 落盘）。
//
// 协议（JSON over HTTP，全部 /v1 前缀）：
//   POST /v1/register   {peerId, fingerprint, token, meta?}   → 建立/刷新注册（TTL 默认 90s）
//   POST /v1/heartbeat  {peerId, token}                       → 刷新 TTL（轻量，不改元数据）
//   POST /v1/leave      {peerId, token}                       → 主动下线
//   GET  /v1/lookup?id=<peerId>                               → 单个查询（公开，无需密钥）
//   GET  /v1/lookup?ids=<a,b,c>                               → 批量查询
//   GET  /v1/healthz                                          → 存活 + 统计
//   GET  /v1/dump                                             → 全量（需密钥，调试用）
//
// token 字段是 daemon 的「注册凭证」（不是 PeerJS 信令 token），由 daemon 自己生成
// 并持久化；registry 只比对「同一 peerId 的 token 是否一致」，一致才允许覆盖/下线，
// 防止陌生人抢注同名 ID。
package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultListen  = "127.0.0.1:9600"
	defaultTTL     = 90 * time.Second
	maxPeerIDLen   = 64
	maxTokenLen    = 200
	maxFingerprint = 64
	maxBatch       = 200
)

// record 一个 peerId 的注册项。token 只在响应「本人」或带密钥的 dump 里返回，
// 公开 lookup 不泄露（否则任何人可冒名覆盖）。
type record struct {
	PeerID      string    `json:"peerId"`
	Fingerprint string    `json:"fingerprint"`
	Token       string    `json:"-"`
	Meta        string    `json:"meta,omitempty"`
	Source      string    `json:"source"` // 上报来源（remote addr 或 socket）
	FirstSeen   time.Time `json:"firstSeen"`
	LastSeen    time.Time `json:"lastSeen"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func (r *record) alive(now time.Time) bool { return now.Before(r.ExpiresAt) }

// publicView lookup 的脱敏视图。
func (r *record) publicView(now time.Time) map[string]any {
	return map[string]any{
		"peerId":      r.PeerID,
		"fingerprint": r.Fingerprint,
		"online":      r.alive(now),
		"meta":        r.Meta,
		"source":      r.Source,
		"firstSeen":   r.FirstSeen,
		"lastSeen":    r.LastSeen,
		"expiresAt":   r.ExpiresAt,
	}
}

type registry struct {
	mu      sync.RWMutex
	ttl     time.Duration
	records map[string]*record
	// 简单统计（healthz 用，不落盘敏感信息）
	registrations uint64
	heartbeats    uint64
	lookups       uint64
}

func newRegistry(ttl time.Duration) *registry {
	return &registry{ttl: ttl, records: make(map[string]*record)}
}

// upsert 注册或刷新。token 一致才允许覆盖；首次注册建立 token 所有权。
func (g *registry) upsert(peerID, fingerprint, token, meta, source string, now time.Time) (*record, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	existing, ok := g.records[peerID]
	if ok {
		// token 比对用常数时间，防侧信道（虽然本机场景风险低，但习惯要养）。
		if subtle.ConstantTimeCompare([]byte(existing.Token), []byte(token)) != 1 {
			return nil, errors.New("token-mismatch")
		}
		if fingerprint != "" {
			existing.Fingerprint = fingerprint
		}
		if meta != "" {
			existing.Meta = meta
		}
		existing.Source = source
		existing.LastSeen = now
		existing.ExpiresAt = now.Add(g.ttl)
		g.registrations++
		return existing, nil
	}
	rec := &record{
		PeerID:      peerID,
		Fingerprint: fingerprint,
		Token:       token,
		Meta:        meta,
		Source:      source,
		FirstSeen:   now,
		LastSeen:    now,
		ExpiresAt:   now.Add(g.ttl),
	}
	g.records[peerID] = rec
	g.registrations++
	return rec, nil
}

func (g *registry) heartbeat(peerID, token string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	rec, ok := g.records[peerID]
	if !ok || subtle.ConstantTimeCompare([]byte(rec.Token), []byte(token)) != 1 {
		return false
	}
	rec.LastSeen = now
	rec.ExpiresAt = now.Add(g.ttl)
	g.heartbeats++
	return true
}

func (g *registry) leave(peerID, token string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	rec, ok := g.records[peerID]
	if !ok || subtle.ConstantTimeCompare([]byte(rec.Token), []byte(token)) != 1 {
		return false
	}
	rec.ExpiresAt = now // 立即过期，不删除（保留 firstSeen 便于审计）
	return true
}

func (g *registry) lookup(ids []string, now time.Time) map[string]any {
	g.mu.RLock()
	defer g.mu.RUnlock()
	g.mu.Lock()
	g.lookups++
	g.mu.Unlock()
	out := make(map[string]any, len(ids))
	for _, id := range ids {
		if rec, ok := g.records[id]; ok {
			out[id] = rec.publicView(now)
		} else {
			out[id] = map[string]any{"peerId": id, "online": false, "registered": false}
		}
	}
	return out
}

// sweep 周期清理过期记录（内存不膨胀；保留最近 1 小时的墓碑便于审计）。
func (g *registry) sweep(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			g.mu.Lock()
			for id, rec := range g.records {
				if now.After(rec.ExpiresAt.Add(time.Hour)) {
					delete(g.records, id)
				}
			}
			g.mu.Unlock()
		}
	}
}

// ── HTTP 层 ─────────────────────────────────────────────────────────────────

type server struct {
	reg   *registry
	auth  string
	state string
	mu    sync.Mutex // state 落盘串行化
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	body, err := json.Marshal(value)
	if err != nil {
		http.Error(w, `{"ok":false,"error":"encode"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	return decoder.Decode(dst)
}

func validPeerID(id string) bool {
	if len(id) < 16 || len(id) > maxPeerIDLen || !strings.HasPrefix(id, "dsh-pm-") {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

func validToken(token string) bool {
	return len(token) >= 8 && len(token) <= maxTokenLen
}

func (s *server) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if s.auth == "" {
		return true // 未配置密钥：仅 loopback 场景，写入端点仍要求显式无密钥
	}
	got := r.Header.Get("x-registry-auth")
	if subtle.ConstantTimeCompare([]byte(got), []byte(s.auth)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "bad-auth"})
		return false
	}
	return true
}

func (s *server) routes() *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("/v1/healthz", func(w http.ResponseWriter, r *http.Request) {
		s.reg.mu.RLock()
		total := len(s.reg.records)
		online := 0
		now := time.Now()
		for _, rec := range s.reg.records {
			if rec.alive(now) {
				online++
			}
		}
		s.reg.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "records": total, "online": online,
			"registrations": s.reg.registrations, "heartbeats": s.reg.heartbeats, "lookups": s.reg.lookups,
			"ttlSeconds": s.reg.ttl.Seconds(),
		})
	})

	mux.HandleFunc("/v1/register", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !s.requireAuth(w, r) {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method"})
			return
		}
		var body struct {
			PeerID      string `json:"peerId"`
			Fingerprint string `json:"fingerprint"`
			Token       string `json:"token"`
			Meta        string `json:"meta"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-json"})
			return
		}
		if !validPeerID(body.PeerID) || !validToken(body.Token) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-peer-or-token"})
			return
		}
		if len(body.Fingerprint) > maxFingerprint {
			body.Fingerprint = body.Fingerprint[:maxFingerprint]
		}
		if len(body.Meta) > 200 {
			body.Meta = body.Meta[:200]
		}
		source := r.RemoteAddr
		if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
			source = host
		}
		rec, err := s.reg.upsert(body.PeerID, body.Fingerprint, body.Token, body.Meta, source, time.Now())
		if err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		s.persist()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "record": rec.publicView(time.Now())})
	})

	mux.HandleFunc("/v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !s.requireAuth(w, r) {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method"})
			return
		}
		var body struct {
			PeerID string `json:"peerId"`
			Token  string `json:"token"`
		}
		if err := readJSON(r, &body); err != nil || !validPeerID(body.PeerID) || !validToken(body.Token) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid"})
			return
		}
		if !s.reg.heartbeat(body.PeerID, body.Token, time.Now()) {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not-registered-or-token-mismatch"})
			return
		}
		s.persist()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("/v1/leave", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !s.requireAuth(w, r) {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method"})
			return
		}
		var body struct {
			PeerID string `json:"peerId"`
			Token  string `json:"token"`
		}
		if err := readJSON(r, &body); err != nil || !validPeerID(body.PeerID) || !validToken(body.Token) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid"})
			return
		}
		if !s.reg.leave(body.PeerID, body.Token, time.Now()) {
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not-registered-or-token-mismatch"})
			return
		}
		s.persist()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})

	mux.HandleFunc("/v1/lookup", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method"})
			return
		}
		var ids []string
		if single := r.URL.Query().Get("id"); single != "" {
			ids = []string{single}
		} else if batch := r.URL.Query().Get("ids"); batch != "" {
			for _, part := range strings.Split(batch, ",") {
				part = strings.TrimSpace(part)
				if part != "" {
					ids = append(ids, part)
				}
			}
		}
		if len(ids) == 0 || len(ids) > maxBatch {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "ids-empty-or-too-many"})
			return
		}
		for _, id := range ids {
			if !validPeerID(id) {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid-peer", "peerId": id})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "results": s.reg.lookup(ids, time.Now())})
	})

	mux.HandleFunc("/v1/dump", func(w http.ResponseWriter, r *http.Request) {
		if !s.requireAuth(w, r) {
			return
		}
		s.reg.mu.RLock()
		now := time.Now()
		list := make([]map[string]any, 0, len(s.reg.records))
		for _, rec := range s.reg.records {
			list = append(list, rec.publicView(now))
		}
		s.reg.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "records": list})
	})

	return mux
}

// persist 可选落盘（仅注册元数据，不含 token 明文以外任何秘密）。
func (s *server) persist() {
	if s.state == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reg.mu.RLock()
	now := time.Now()
	list := make([]map[string]any, 0, len(s.reg.records))
	for _, rec := range s.reg.records {
		if rec.alive(now) {
			list = append(list, map[string]any{
				"peerId":      rec.PeerID,
				"fingerprint": rec.Fingerprint,
				"token":       rec.Token,
				"meta":        rec.Meta,
				"source":      rec.Source,
				"firstSeen":   rec.FirstSeen,
				"lastSeen":    rec.LastSeen,
				"expiresAt":   rec.ExpiresAt,
			})
		}
	}
	s.reg.mu.RUnlock()
	body, err := json.MarshalIndent(map[string]any{"version": 1, "savedAt": now, "records": list}, "", "  ")
	if err != nil {
		return
	}
	tmp := s.state + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, s.state)
}

// restore 启动时载入存活记录（token 一并恢复，保证重启后 heartbeat 仍认原注册）。
func (s *server) restore() {
	if s.state == "" {
		return
	}
	body, err := os.ReadFile(s.state)
	if err != nil {
		return
	}
	var dump struct {
		Records []struct {
			PeerID      string    `json:"peerId"`
			Fingerprint string    `json:"fingerprint"`
			Token       string    `json:"token"`
			Meta        string    `json:"meta"`
			Source      string    `json:"source"`
			FirstSeen   time.Time `json:"firstSeen"`
			LastSeen    time.Time `json:"lastSeen"`
			ExpiresAt   time.Time `json:"expiresAt"`
		} `json:"records"`
	}
	if err := json.Unmarshal(body, &dump); err != nil {
		return
	}
	now := time.Now()
	s.reg.mu.Lock()
	defer s.reg.mu.Unlock()
	for _, item := range dump.Records {
		if !validPeerID(item.PeerID) || !validToken(item.Token) || now.After(item.ExpiresAt) {
			continue
		}
		s.reg.records[item.PeerID] = &record{
			PeerID:      item.PeerID,
			Fingerprint: item.Fingerprint,
			Token:       item.Token,
			Meta:        item.Meta,
			Source:      item.Source,
			FirstSeen:   item.FirstSeen,
			LastSeen:    item.LastSeen,
			ExpiresAt:   item.ExpiresAt,
		}
	}
}

func main() {
	var (
		listen = flag.String("listen", defaultListen, "监听地址：host:port 或 unix:///path/to.sock（默认 loopback）")
		ttl    = flag.Duration("ttl", defaultTTL, "注册 TTL；heartbeat 刷新，过期判离线")
		auth   = flag.String("auth", os.Getenv("PM_REGISTRY_AUTH"), "写入端点共享密钥（也可走 PM_REGISTRY_AUTH）")
		state  = flag.String("state", "", "可选：注册表落盘路径（0600），重启恢复存活记录")
	)
	flag.Parse()

	if *auth == "" {
		log.Println("[pm-registry] 警告：未设置 -auth/PM_REGISTRY_AUTH，写入端点无鉴权（仅建议在受信 loopback 下运行）")
	}

	srv := &server{reg: newRegistry(*ttl), auth: *auth, state: *state}
	srv.restore()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go srv.reg.sweep(ctx)

	httpServer := &http.Server{
		Handler:           srv.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
	}

	var listener net.Listener
	var err error
	if strings.HasPrefix(*listen, "unix://") {
		path := strings.TrimPrefix(*listen, "unix://")
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			log.Fatalf("mkdir socket dir: %v", err)
		}
		_ = os.Remove(path)
		listener, err = net.Listen("unix", path)
		if err == nil {
			_ = os.Chmod(path, 0o600)
		}
	} else {
		// 非 loopback 显式警告：presence 服务暴露到 LAN 需要你自己评估威胁面。
		if host, _, splitErr := net.SplitHostPort(*listen); splitErr == nil {
			if ip := net.ParseIP(host); ip != nil && !ip.IsLoopback() {
				log.Printf("[pm-registry] 注意：监听非 loopback 地址 %s，确认你已用 -auth 保护写入端点", *listen)
			}
		}
		listener, err = net.Listen("tcp", *listen)
	}
	if err != nil {
		log.Fatalf("listen %s: %v", *listen, err)
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	log.Printf("[pm-registry] listening on %s (ttl=%s, auth=%t, state=%q)", *listen, *ttl, *auth != "", *state)
	if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("serve: %v", err)
	}
	fmt.Println("[pm-registry] stopped")
}
