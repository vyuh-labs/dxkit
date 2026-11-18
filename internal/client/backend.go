// Consumed surface: stdlib client calls binding the served forms above. The
// last call's URL is runtime-built — the coverage-honesty channel must COUNT
// it as a dynamic call site, never silently drop it.
package client

import "net/http"

func Check() error {
	_, err := http.Get("/healthz") // → ANY /healthz (method-agnostic route)
	return err
}

func ExportReports() error {
	req, err := http.NewRequest("GET", "/reports/export", nil) // → GET /reports/export
	_ = req
	return err
}

func CreateReport() error {
	_, err := http.Post("/reports", "application/json", nil) // → POST /reports (chi)
	return err
}

func Opaque(url string) error {
	_, err := http.Get(url) // dynamic: recognized, unverifiable, DISCLOSED
	return err
}
