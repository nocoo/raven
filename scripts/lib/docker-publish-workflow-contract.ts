/** Workflow contract constants for offline unit tests (pins verified manually / in CI lint). */

export const DOCKER_PUBLISH_TOOLING_CHECKOUT_PATH = ".ci-tooling"
export const DOCKER_PUBLISH_RELEASE_CHECKOUT_PATH = "release"

export const DOCKER_PUBLISH_ACTION_PINS = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e",
  "docker/login-action@dbcb813823bdd20940b903addbd779551569679f",
  "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  "nocoo/base-ci/.github/actions/release-source@633a5545fcfec91b688840650d4edf3e9cc1abbd",
] as const

export const DOCKER_PUBLISH_BUN_VERSION = "1.3.11"
