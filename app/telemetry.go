package main

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type telemetry struct {
	provider *sdktrace.TracerProvider
	registry *prometheus.Registry
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
}

func newTelemetry(ctx context.Context) (*telemetry, error) {
	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}
	t := &telemetry{
		provider: sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exporter, sdktrace.WithBatchTimeout(time.Second)),
			sdktrace.WithSampler(sdktrace.AlwaysSample()),
			sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", "workshop-app"))),
		),
		registry: prometheus.NewRegistry(),
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "workshop_http_requests_total", Help: "Completed create/read requests.",
		}, []string{"method", "route", "status"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "workshop_http_request_duration_seconds", Help: "Create/read request latency.",
			Buckets: prometheus.DefBuckets,
		}, []string{"method", "route", "status"}),
	}
	t.registry.MustRegister(t.requests, t.duration, collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	return t, nil
}

func (t *telemetry) observe(route string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		ctx, span := t.provider.Tracer("workshop/http").Start(ctx, r.Method+" "+route,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(attribute.String("http.request.method", r.Method), attribute.String("http.route", route)))
		defer span.End()
		w.Header().Set("X-Trace-ID", span.SpanContext().TraceID().String())
		response := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(response, r.WithContext(ctx))
		status := strconv.Itoa(response.status)
		t.requests.WithLabelValues(r.Method, route, status).Inc()
		t.duration.WithLabelValues(r.Method, route, status).Observe(time.Since(start).Seconds())
		span.SetAttributes(attribute.Int("http.response.status_code", response.status))
		if response.status >= 500 {
			span.SetStatus(codes.Error, http.StatusText(response.status))
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (w *statusWriter) WriteHeader(status int) {
	if w.wroteHeader {
		return
	}
	w.wroteHeader = true
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(p []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}
