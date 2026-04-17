#!/bin/bash
set -e

echo "Running proxy unit tests..."
bun run test

echo "Running type checking..."
bun run typecheck

echo "All checks passed!"
