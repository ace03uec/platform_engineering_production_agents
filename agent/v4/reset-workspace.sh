#!/bin/sh
# Recreate the demo workspace files after a v4 remediation run.
set -e
docker exec workshop-agent node src/workspace.mjs --force
