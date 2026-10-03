// Minimal Go service. Replace it with your application — the pipeline around
// it (Dockerfile, compose.yaml, .github/workflows/deploy.yml) is what
// PromptWorkspace seeded, and it does not care what this file grows into.
package main

import (
	"net/http"
	"os"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	// Passed in by compose from the deploy workflow. Naming the PromptWorkspace web
	// origin as a frame ancestor is what lets the project's Preview tab embed
	// this app instead of falling back to a link card.
	webOrigin := os.Getenv("PROMPTWORKSPACE_WEB_ORIGIN")

	files := http.FileServer(http.Dir("public"))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/plain")
		w.Write([]byte("ok"))
	})
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if webOrigin != "" {
			w.Header().Set("content-security-policy", "frame-ancestors "+webOrigin)
		}
		files.ServeHTTP(w, r)
	}))

	http.ListenAndServe("0.0.0.0:"+port, mux)
}
