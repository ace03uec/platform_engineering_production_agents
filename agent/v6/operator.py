#!/usr/bin/env python3
"""Local operator client. Reads only OPERATOR_TOKEN from ignored agent/.env."""
import json
import sys
import urllib.request
from pathlib import Path

command = sys.argv[1] if len(sys.argv) > 1 else 'status'
if command not in ('status', 'demo', 'approve', 'reject'):
    raise SystemExit('Usage: operator.py status|demo|approve ID|reject ID')
lines = (Path(__file__).resolve().parents[1] / '.env').read_text().splitlines()
token = next((line.split('=', 1)[1].strip() for line in lines if line.startswith('OPERATOR_TOKEN=')), '')
if not token:
    raise SystemExit('Configure OPERATOR_TOKEN in agent/.env')
path = '/safety'
if command == 'demo':
    path += '/demo'
elif command in ('approve', 'reject'):
    if len(sys.argv) != 3:
        raise SystemExit('Supply approval ID')
    path += '/' + sys.argv[2] + '/' + command
request = urllib.request.Request('http://127.0.0.1:8090' + path,
    method='GET' if command == 'status' else 'POST',
    headers={'Authorization': 'Bearer ' + token})
with urllib.request.urlopen(request, timeout=10) as response:
    print(json.dumps(json.load(response), indent=2))
