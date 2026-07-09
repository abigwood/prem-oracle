#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
ThreadingHTTPServer(("0.0.0.0", 8899), SimpleHTTPRequestHandler).serve_forever()
