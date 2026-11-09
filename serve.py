#!/usr/bin/env python3
"""Local server for the Circuit Tools 3 web replica.

Besides serving the static app it gives the browser what it cannot do on its own:
  /api/ls?path=…          list a local folder (dirs + .vbo/.mp4 files)
  /api/find?name=a,b,c    locate files by exact name (Spotlight mdfind on macOS, with a walk fallback)
  /api/file?path=…        stream a local file with HTTP Range support (needed for smooth video seeking)
Only paths under the user's home folder and /Volumes are allowed, and it binds to 127.0.0.1 only.

Usage: python3 serve.py [port]   then open http://127.0.0.1:8765/
"""
import http.server, socketserver, sys, os, mimetypes, json, subprocess, urllib.parse, time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser('~')
ALLOWED = [HOME, '/Volumes']
MEDIA_EXT = ('.vbo', '.mp4', '.mov', '.m4v', '.webm', '.vbb', '.cir')
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('video/mp4', '.mp4')
mimetypes.add_type('video/quicktime', '.mov')
mimetypes.add_type('text/plain', '.vbo')

def allowed(p):
    rp = os.path.realpath(p)
    return any(rp == a or rp.startswith(a + '/') for a in ALLOWED)

SEARCH_ROOTS = [os.path.join(HOME, d) for d in ('Desktop', 'Documents', 'Downloads', 'Movies')]

def walk_find(wanted, budget_s=4.0, max_depth=6):
    """Fallback for volumes Spotlight does not index (external SSDs): bounded walk of likely folders."""
    roots = list(SEARCH_ROOTS)
    try:
        roots += [os.path.join('/Volumes', v) for v in os.listdir('/Volumes') if v != 'Macintosh HD']
    except Exception:
        pass
    found = {n: [] for n in wanted}
    t0 = time.time()
    for root in roots:
        if not os.path.isdir(root):
            continue
        base_depth = root.rstrip('/').count('/')
        for dirpath, dirnames, filenames in os.walk(root):
            if time.time() - t0 > budget_s:
                return found
            dirnames[:] = [d for d in dirnames if not d.startswith('.') and d not in ('node_modules', 'Library', '.git', '.build')]
            if dirpath.count('/') - base_depth >= max_depth:
                dirnames[:] = []
            for n in wanted:
                if n in filenames and not found[n]:
                    found[n].append(os.path.join(dirpath, n))
            if all(found[n] for n in wanted):
                return found
    return found

def find_by_name(names):
    out = {}
    for n in names:
        hits = []
        try:
            q = subprocess.run(['mdfind', '-name', n], capture_output=True, text=True, timeout=8)
            hits = [h for h in q.stdout.splitlines() if os.path.basename(h) == n and allowed(h)]
        except Exception:
            pass
        out[n] = hits
    missing = [n for n in names if not out[n]]
    if missing:
        out.update({k: v for k, v in walk_find(missing).items() if v})
    return out

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Accept-Ranges', 'bytes')
        super().end_headers()

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path == '/api/ls':
            return self.api_ls(qs.get('path', [HOME])[0])
        if u.path == '/api/find':
            names = [n for n in qs.get('name', [''])[0].split(',') if n]
            return self.send_json(find_by_name(names))
        if u.path == '/api/file':
            return self.api_file(qs.get('path', [''])[0])
        if u.path == '/api/roots':
            roots = [{'name': 'Home', 'path': HOME}, {'name': 'Desktop', 'path': os.path.join(HOME, 'Desktop')},
                     {'name': 'Documents', 'path': os.path.join(HOME, 'Documents')}, {'name': 'Downloads', 'path': os.path.join(HOME, 'Downloads')}]
            try:
                for v in sorted(os.listdir('/Volumes')):
                    if v != 'Macintosh HD':
                        roots.append({'name': v + ' (volume)', 'path': os.path.join('/Volumes', v)})
            except Exception:
                pass
            return self.send_json(roots)
        return super().do_GET()

    def api_ls(self, path):
        path = os.path.expanduser(path)
        if not allowed(path) or not os.path.isdir(path):
            return self.send_json({'error': 'not allowed or not a folder', 'path': path}, 403)
        dirs, files = [], []
        try:
            for name in sorted(os.listdir(path), key=str.lower):
                if name.startswith('.'):
                    continue
                full = os.path.join(path, name)
                try:
                    st = os.stat(full)
                except Exception:
                    continue
                if os.path.isdir(full):
                    dirs.append({'name': name, 'path': full})
                elif name.lower().endswith(MEDIA_EXT):
                    files.append({'name': name, 'path': full, 'size': st.st_size, 'mtime': time.strftime('%Y-%m-%d %H:%M', time.localtime(st.st_mtime))})
        except PermissionError:
            return self.send_json({'error': 'permission denied', 'path': path}, 403)
        return self.send_json({'path': path, 'parent': os.path.dirname(path) if path not in ('/',) else None, 'dirs': dirs, 'files': files})

    def api_file(self, path):
        if not path or not allowed(path) or not os.path.isfile(path):
            self.send_error(404, 'file not found or not allowed')
            return
        size = os.path.getsize(path)
        ctype = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        rng = self.headers.get('Range')
        start, end = 0, size - 1
        if rng and rng.startswith('bytes='):
            a, _, b = rng[6:].partition('-')
            try:
                if a:
                    start = int(a)
                    end = int(b) if b else size - 1
                else:
                    start = max(0, size - int(b))
            except ValueError:
                start, end = 0, size - 1
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header('Content-Range', f'bytes */{size}')
                self.end_headers()
                return
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        else:
            self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(end - start + 1))
        self.send_header('Content-Disposition', 'inline; filename="%s"' % os.path.basename(path).replace('"', ''))
        self.end_headers()
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    with Server(('127.0.0.1', PORT), H) as httpd:
        print(f'Circuit Tools 3 replica: http://127.0.0.1:{PORT}/')
        httpd.serve_forever()
