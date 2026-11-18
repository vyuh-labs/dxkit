// Served surface: stdlib registrars (plain + Go 1.22 verb patterns) and a
// chi-style router verb method.
package server

import "net/http"

func Register(mux *http.ServeMux) {
	mux.HandleFunc("/healthz", healthz)
	mux.HandleFunc("GET /reports/{id}", reportDetail)
	mux.HandleFunc("GET /reports/export", reportExport)
}

func RegisterChi(r Router) {
	r.Post("/reports", createReport)
}
