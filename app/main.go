// A small workshop create/read service. PostgreSQL is accessed through PgBouncer;
// Redis counts requests. Failure injection is simulated and request-local.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

type item struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type application struct {
	db    *pgxpool.Pool
	redis *redis.Client
}

func main() {
	if err := run(); err != nil {
		slog.Error("application stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	telemetry, err := newTelemetry(ctx)
	if err != nil {
		return fmt.Errorf("initialize telemetry: %w", err)
	}
	defer func() {
		flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := telemetry.provider.Shutdown(flush); err != nil {
			slog.Error("flush traces", "error", err)
		}
	}()
	config, err := pgxpool.ParseConfig(env("DATABASE_URL", "postgres://workshop:workshop@localhost:6432/workshop?sslmode=disable"))
	if err != nil {
		return fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	// Avoid prepared statements so transaction-mode PgBouncer works without
	// requiring prepared-statement support in the pooler.
	config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec
	config.ConnConfig.ConnectTimeout = 3 * time.Second
	config.MaxConns = 5
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		return err
	}
	defer db.Close()
	redisOptions, err := redis.ParseURL(env("REDIS_URL", "redis://localhost:6379/0"))
	if err != nil {
		return fmt.Errorf("parse REDIS_URL: %w", err)
	}
	redisOptions.DialTimeout = 2 * time.Second
	redisOptions.ReadTimeout = 2 * time.Second
	redisOptions.WriteTimeout = 2 * time.Second
	redisOptions.ContextTimeoutEnabled = true
	cache := redis.NewClient(redisOptions)
	defer cache.Close()
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.Ping(startup); err != nil {
		return fmt.Errorf("connect to PostgreSQL through PgBouncer: %w", err)
	}
	if err := cache.Ping(startup).Err(); err != nil {
		return fmt.Errorf("connect to Redis: %w", err)
	}
	_, err = db.Exec(startup, `CREATE TABLE IF NOT EXISTS items (
		id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
		name TEXT NOT NULL CHECK (length(trim(name)) > 0)
	)`)
	if err != nil {
		return fmt.Errorf("create items table: %w", err)
	}

	a := &application{db: db, redis: cache}
	mux := http.NewServeMux()
	mux.Handle("POST /post", telemetry.observe("/post", http.HandlerFunc(a.crud)))
	mux.Handle("GET /get", telemetry.observe("/get", http.HandlerFunc(a.crud)))
	mux.HandleFunc("GET /live", liveness)
	mux.HandleFunc("GET /ready", a.health)
	mux.HandleFunc("GET /health", a.health)
	mux.Handle("GET /metrics", promhttp.HandlerFor(telemetry.registry, promhttp.HandlerOpts{}))
	server := &http.Server{
		Addr: env("HTTP_ADDR", ":8080"), Handler: mux,
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second,
	}
	result := make(chan error, 1)
	go func() { result <- server.ListenAndServe() }()
	slog.Info("listening", "address", server.Addr)
	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			_ = server.Close()
			return err
		}
		return nil
	}
}

func (a *application) crud(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	// Validate every flag before injecting anything. Multiple flags are reported
	// together, with no database writes or changes to service availability.
	failures, err := parseFailures(r.URL.Query().Get("fails"))
	if err != nil {
		respond(w, 400, map[string]any{"error": err.Error()})
		return
	}
	if len(failures) > 0 {
		trace.SpanFromContext(ctx).SetAttributes(attribute.StringSlice("workshop.failures", failures))
		status := http.StatusServiceUnavailable
		for _, failure := range failures {
			slog.Error("simulated failure", "failure", failure, "route", r.URL.Path)
			if failure == "app" {
				status = http.StatusInternalServerError
			}
		}
		respond(w, status, map[string]any{"error": "simulated failure", "fails": failures})
		return
	}
	var id int64
	if r.URL.Query().Has("id") {
		id, err = strconv.ParseInt(r.URL.Query().Get("id"), 10, 64)
		if err != nil || id <= 0 {
			respond(w, 400, map[string]any{"error": "id must be a positive integer"})
			return
		}
	}
	var input struct {
		Name string `json:"name"`
	}
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil {
			respond(w, 400, map[string]any{"error": "expected JSON object with name"})
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			respond(w, 400, map[string]any{"error": "expected one JSON object"})
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		if input.Name == "" {
			respond(w, 400, map[string]any{"error": "name is required"})
			return
		}
	}
	// Redis is an explicit dependency for this lab. Count valid create/read attempts
	// before SQL, so Redis outages cannot cause partially committed writes.
	if err := a.redis.Incr(ctx, "workshop:requests").Err(); err != nil {
		dependencyError(w, "redis", err)
		return
	}
	switch r.Method {
	case http.MethodPost:
		var saved item
		err = a.db.QueryRow(ctx, "INSERT INTO items (name) VALUES ($1) RETURNING id, name", input.Name).Scan(&saved.ID, &saved.Name)
		if err != nil {
			dependencyError(w, "postgres", err)
			return
		}
		respond(w, http.StatusCreated, saved)
	case http.MethodGet:
		if id > 0 {
			var found item
			err = a.db.QueryRow(ctx, "SELECT id, name FROM items WHERE id=$1", id).Scan(&found.ID, &found.Name)
			if err != nil {
				dependencyError(w, "postgres", err)
				return
			}
			respond(w, 200, found)
			return
		}
		rows, err := a.db.Query(ctx, "SELECT id, name FROM items ORDER BY id LIMIT 100")
		if err != nil {
			dependencyError(w, "postgres", err)
			return
		}
		defer rows.Close()
		items := []item{}
		for rows.Next() {
			var found item
			if err := rows.Scan(&found.ID, &found.Name); err != nil {
				dependencyError(w, "postgres", err)
				return
			}
			items = append(items, found)
		}
		if err := rows.Err(); err != nil {
			dependencyError(w, "postgres", err)
			return
		}
		respond(w, 200, items)

	}
}

func liveness(w http.ResponseWriter, r *http.Request) {
	respond(w, http.StatusOK, map[string]any{"status": "alive"})
}

func (a *application) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := a.db.Ping(ctx); err != nil {
		dependencyError(w, "postgres", err)
		return
	}
	if err := a.redis.Ping(ctx).Err(); err != nil {
		dependencyError(w, "redis", err)
		return
	}
	respond(w, 200, map[string]any{"status": "ok"})
}

func parseFailures(raw string) ([]string, error) {
	var failures []string
	if raw == "" {
		return failures, nil
	}
	seen := map[string]bool{}
	for _, flag := range strings.Split(raw, ",") {
		flag = strings.TrimSpace(flag)
		switch flag {
		case "db_conn", "db_space", "redis", "app":
			if !seen[flag] {
				failures = append(failures, flag)
				seen[flag] = true
			}
		default:
			return nil, fmt.Errorf("unknown failure %q; use db_conn, db_space, redis, app", flag)
		}
	}
	return failures, nil
}

func dependencyError(w http.ResponseWriter, dependency string, err error) {
	if errors.Is(err, pgx.ErrNoRows) {
		respond(w, 404, map[string]any{"error": "item not found"})
		return
	}
	slog.Error("dependency failed", "dependency", dependency, "error", err)
	respond(w, 503, map[string]any{"error": dependency + " unavailable"})
}

func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		slog.Error("write response", "error", err)
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
