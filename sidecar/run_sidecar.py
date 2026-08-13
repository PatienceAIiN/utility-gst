"""Frozen-binary entry point.

PyInstaller runs its target as __main__, so freezing gstparse/cli.py directly
breaks every relative import inside the package. This shim keeps gstparse a
real package and imports it absolutely, which is what both the Linux and
Windows onedir builds are pointed at.
"""

from gstparse.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
