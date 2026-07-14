FROM denoland/deno:2.8.3
WORKDIR /app

COPY . .

# Debian (not Alpine) base: the corpus's local embedder (transformers.js) loads
# onnxruntime-node's native binding, which ships glibc builds only — same
# reasoning as dead-reckoning's Dockerfile. sharp/protobufjs are transitive
# deps of the same package. --node-modules-dir=auto matches the `serve` task
# (deno.jsonc) so the native binding actually gets built here, not skipped.
RUN deno install --node-modules-dir=auto --allow-scripts=npm:onnxruntime-node,npm:sharp,npm:protobufjs

EXPOSE 8420

# Runs the real `serve` task (deno.jsonc is the single source of truth for the
# permission grant) rather than reconstructing the flags here. --host 0.0.0.0:
# the CLI default (127.0.0.1, SECURITY.md §3a) is unreachable from outside the
# container's network namespace; Docker only forwards the published port, and
# nucklehead's Caddy (Tailscale/localhost-scoped) is the actual boundary — same
# posture as this app's container siblings (dead-reckoning, tower-expert).
CMD ["sh", "-c", "exec deno task serve --host 0.0.0.0 --port ${PORT:-8420}"]
