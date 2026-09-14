package main

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLivenessDoesNotNeedDependencies(t *testing.T) {
	w := httptest.NewRecorder()
	liveness(w, httptest.NewRequest("GET", "/live", nil))
	if w.Code != 200 {
		t.Fatalf("liveness status = %d", w.Code)
	}
}

func TestReadinessFailsWhenDatabaseUnavailable(t *testing.T) {
	db, err := pgxpool.New(context.Background(), "postgres://workshop:workshop@127.0.0.1:1/workshop?connect_timeout=1")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	a := &application{db: db}
	w := httptest.NewRecorder()
	a.health(w, httptest.NewRequest("GET", "/ready", nil))
	if w.Code != 503 {
		t.Fatalf("readiness status = %d, expected 503", w.Code)
	}
}
