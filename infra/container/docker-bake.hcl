# OPS-9: one `docker buildx bake` builds every image from the shared workspace stages in parallel.
# scripts/deploy/build-images.sh sets these variables; run it rather than bake by hand.
variable "REGISTRY" {
  default = "ovo"
}

variable "REVISION" {
  default = "dev"
}

variable "PLATFORM" {
  default = "linux/amd64"
}

group "default" {
  targets = ["api", "console", "gateway", "dispatcher", "worker", "tools"]
}

target "_common" {
  context    = "."
  dockerfile = "infra/container/Dockerfile"
  platforms  = [PLATFORM]
  args = {
    OVO_REVISION = REVISION
  }
  labels = {
    "org.opencontainers.image.revision" = REVISION
    "org.opencontainers.image.source"   = "https://github.com/winsenlabs/ovo"
  }
}

target "api" {
  inherits = ["_common"]
  target   = "api"
  tags     = ["${REGISTRY}/ovo-api:${REVISION}"]
}

target "console" {
  inherits = ["_common"]
  target   = "console"
  tags     = ["${REGISTRY}/ovo-console:${REVISION}"]
}

target "gateway" {
  inherits = ["_common"]
  target   = "gateway"
  tags     = ["${REGISTRY}/ovo-gateway:${REVISION}"]
}

target "dispatcher" {
  inherits = ["_common"]
  target   = "dispatcher"
  tags     = ["${REGISTRY}/ovo-dispatcher:${REVISION}"]
}

target "worker" {
  inherits = ["_common"]
  target   = "worker"
  tags     = ["${REGISTRY}/ovo-worker:${REVISION}"]
}

# The `workspace` stage runs one-off tools such as secrets-rewrap (compose profile `tools`).
target "tools" {
  inherits = ["_common"]
  target   = "workspace"
  tags     = ["${REGISTRY}/ovo-tools:${REVISION}"]
}
