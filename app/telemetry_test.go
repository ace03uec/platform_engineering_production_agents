package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func TestTelemetryRecordsResponseAndPropagatesTrace(t *testing.T) {
	telemetry, err := newTelemetry(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	_ = telemetry.provider.Shutdown(context.Background())
	recorder := tracetest.NewSpanRecorder()
	telemetry.provider = sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	defer telemetry.provider.Shutdown(context.Background())
	handler := telemetry.observe("/get", http.HandlerFunc((&application{}).crud))
	request := httptest.NewRequest("GET", "/get?fails=db_conn,redis", nil)
	request.Header.Set("traceparent", "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 503 {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Header().Get("X-Trace-ID") != "0123456789abcdef0123456789abcdef" {
		t.Fatal("trace context lost")
	}
	spans := recorder.Ended()
	if len(spans) != 1 || spans[0].Status().Code != codes.Error {
		t.Fatalf("expected one error span: %v", spans)
	}
	if spans[0].Parent().SpanID().String() != "0123456789abcdef" {
		t.Fatal("parent context lost")
	}
	found := false
	for _, attr := range spans[0].Attributes() {
		if string(attr.Key) == "workshop.failures" {
			found = len(attr.Value.AsStringSlice()) == 2
		}
	}
	if !found {
		t.Fatal("missing simulated failure attributes")
	}
	metrics, err := telemetry.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	found = false
	for _, metric := range metrics {
		if metric.GetName() == "workshop_http_requests_total" {
			for _, sample := range metric.Metric {
				if sample.GetCounter().GetValue() == 1 {
					for _, label := range sample.Label {
						if label.GetName() == "status" && label.GetValue() == "503" {
							found = true
						}
					}
				}
			}
		}
	}
	if !found {
		t.Fatal("missing 503 request counter")
	}
}
