"""Crea lo zip per il Chrome Web Store con i soli file dell'estensione.

Uso:  python scripts/build_zip.py [cartella di destinazione]   (default: dist/)
Il nome del file contiene la versione letta da manifest.json.
"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# file e cartelle del repository che non fanno parte dell'estensione
EXCLUDE_DIRS = {".git", ".github", "docs", "scripts", "dist"}
EXCLUDE_FILES = {"README.md", "LICENSE", ".gitignore", ".gitattributes"}


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    version = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))["version"]
    out = os.path.join(out_dir, f"bandwise-eq-{version}.zip")

    files = []
    for root, dirs, names in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDE_DIRS)
        for name in sorted(names):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, ROOT).replace(os.sep, "/")
            if rel in EXCLUDE_FILES:
                continue
            files.append((path, rel))

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path, rel in files:
            z.write(path, rel)

    print(f"{out}: {len(files)} file, {os.path.getsize(out) // 1024} KB")
    for _, rel in files:
        print("  " + rel)


if __name__ == "__main__":
    main()
