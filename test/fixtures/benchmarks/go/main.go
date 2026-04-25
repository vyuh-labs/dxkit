// Package main is a placeholder so the Go module is non-empty.
// The benchmark fixture's purpose is the manifest + lockfile; the
// vulnerability scanners (osv-scanner / govulncheck) read from
// go.mod and go.sum, not from source.
package main

import "github.com/gin-gonic/gin"

func main() {
	r := gin.Default()
	_ = r
}
