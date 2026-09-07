#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-model-by-preset — cross-platform installer.

Discovers the DeepSeek Harness layout (DSH_HOME / ~/.dsh, profile dirs),
reads the plugin package.json, checks the toolchain (dsh / pnpm / npm),
then installs the plugin into a profile by one of three methods:

  A  dev symlink  (local checkout, pnpm link)          dsh plugin --profile X add <repo>
  B  tarball      (npm pack -> file:…tgz)               dsh plugin --profile X add file:<abs.tgz>
  C  GitHub repo  (fetch <owner>/<repo> from GitHub)    dsh plugin --profile X add <owner>/<repo>

Method C makes `dsh plugin` (a thin pnpm forwarder) treat `<owner>/<repo>` as a
GitHub dependency: pnpm clones the published repository from github.com and
installs it as the plugin package. It therefore needs the repo to already be
pushed to GitHub under that owner. The owner is taken from --owner, or detected
from this checkout's `git remote get-url origin` when one is set.

An uninstall (U) method is offered too. Interactive by default (menu of the
available methods), scriptable with flags for automation. Pure stdlib — no
third-party dependencies. Runs on Windows / macOS / Linux (uses subprocess
list-args, no shell).

Examples
--------
  python3 install.py                       # interactive menu
  python3 install.py --method A            # dev symlink into default profile (web)
  python3 install.py --method B --profile web
  python3 install.py --method C            # GitHub install; owner from git remote
  python3 install.py --method U --yes      # uninstall without prompting
  python3 install.py --list                # only print detection, do nothing
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tarfile

DEFAULT_PROFILE = "web"

PLATFORM = sys.platform  # 'linux', 'darwin', 'win32', ...

# Version of DeepSeek Harness this plugin is developed against. Behaviour is only
# guaranteed on an exact match; other versions may work but are not supported.
TARGET_DSH_VERSION = "0.1.1-rc.2"


# ---------------------------------------------------------------------------
# console helpers
# ---------------------------------------------------------------------------

def _c(text: str) -> str:
    """Colourise when stdout is a tty; plain otherwise."""
    if not sys.stdout.isatty():
        return text
    return "\033[96m" + text + "\033[0m"


def _ok(text: str) -> str:
    if not sys.stdout.isatty():
        return text
    return "\033[92m" + text + "\033[0m"


def _warn(text: str) -> str:
    if not sys.stdout.isatty():
        return text
    return "\033[93m" + text + "\033[0m"


def _err(text: str) -> str:
    if not sys.stdout.isatty():
        return text
    return "\033[91m" + text + "\033[0m"


def log(msg: str = "") -> None:
    print(msg)


def prompt_choice(question: str, options: list[tuple[str, str]]) -> str:
    """Ask the user to pick one option; returns the option key."""
    print()
    print(question)
    for key, label in options:
        print(f"  {_c(key)}) {label}")
    while True:
        raw = input("> ").strip().lower()
        for key, _ in options:
            if raw == key.lower():
                return key
        print(_err(f"Invalid choice '{raw}'. Try again."))


def ask_yes_no(question: str, default: bool = True) -> bool:
    suffix = " [Y/n]" if default else " [y/N]"
    while True:
        raw = input(question + suffix + " ").strip().lower()
        if not raw:
            return default
        if raw in ("y", "yes"):
            return True
        if raw in ("n", "no"):
            return False
        print(_err("Answer y or n."))


# ---------------------------------------------------------------------------
# environment detection
# ---------------------------------------------------------------------------

def dsh_home() -> pathlib.Path:
    env = os.environ.get("DSH_HOME")
    if env:
        return pathlib.Path(env).expanduser()
    return pathlib.Path.home() / ".dsh"


def find_profiles(base: pathlib.Path) -> list[str]:
    """Profiles = dirs directly under <dsh_home>/profiles holding a package.json."""
    profiles = []
    root = base / "profiles"
    if root.is_dir():
        for entry in sorted(root.iterdir()):
            if entry.is_dir() and (entry / "package.json").is_file():
                profiles.append(entry.name)
    return profiles or ([DEFAULT_PROFILE] if (base / "profiles").is_dir() else [])


def which(*names: str) -> str | None:
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    return None


def dsh_version(bin_path: str | None) -> str | None:
    """Run `dsh --version` and return the trimmed string, or None if it fails
    (non-zero exit, empty output, or the binary cannot be run)."""
    if not bin_path:
        return None
    try:
        out = subprocess.run(
            [bin_path, "--version"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    version = out.stdout.strip()
    return version or None


_OWNER_RE = re.compile(
    r"(?:github\.com[/:]|git@github\.com:)(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?$"
)


def detect_owner(repo_dir: pathlib.Path) -> str | None:
    """GitHub owner from the checkout's origin remote, else None.

    No package.json / default fallback on purpose: the owner is only ever
    taken from a real configured remote (or an explicit --owner flag), never
    baked in by the installer.
    """
    git = shutil.which("git")
    if not git:
        return None
    try:
        out = subprocess.run(
            [git, "-C", str(repo_dir), "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=10,
        )
        url = out.stdout.strip()
        if not url:
            return None
        match = _OWNER_RE.search(url.replace(".git/", "/"))
        return match.group("owner") if match else None
    except Exception:
        return None


def read_json(path: pathlib.Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


class Detection:
    """Everything the installer learns about the machine / repo / profile."""

    def __init__(self, repo_dir: pathlib.Path):
        self.repo_dir = repo_dir.resolve()
        self.platform = PLATFORM
        self.dsh_bin = which("dsh")
        self.dsh_ver = dsh_version(self.dsh_bin)
        self.pnpm_bin = which("pnpm")
        self.npm_bin = which("npm")
        self.python = sys.executable or "python3"
        self.home = dsh_home()
        self.profiles = find_profiles(self.home)
        # plugin manifest
        self.pkg_path = self.repo_dir / "package.json"
        self.pkg: dict = {}
        if self.pkg_path.is_file():
            self.pkg = read_json(self.pkg_path)
        self.pkg_name: str = self.pkg.get("name", "dsh-model-by-preset")
        self.version: str = self.pkg.get("version", "0.0.0")
        self.tgz_name = f"{self.pkg_name}-{self.version}.tgz"
        self.owner: str | None = detect_owner(self.repo_dir)

    # ---- derived helpers -------------------------------------------------

    def profile_dir(self, profile: str) -> pathlib.Path:
        return self.home / "profiles" / profile

    def github_spec(self, owner: str | None) -> str | None:
        """'<owner>/<pkg>' for method C, or None when no owner is known."""
        return f"{owner}/{self.pkg_name}" if owner else None

    def toolchain_report(self) -> list[str]:
        def ok(name: str, found: bool) -> str:
            return _ok("present") if found else _err("MISSING")
        lines = [
            f"platform        : {self.platform}",
            f"dsh CLI         : {ok('dsh', bool(self.dsh_bin))}  {self.dsh_bin or ''}".rstrip(),
            f"dsh version     : {self.dsh_ver or '(unknown)'}   "
            f"(target for this plugin: {TARGET_DSH_VERSION})",
            f"pnpm            : {ok('pnpm', bool(self.pnpm_bin))}  {self.pnpm_bin or ''}".rstrip(),
            f"npm             : {ok('npm', bool(self.npm_bin))}  {self.npm_bin or ''}".rstrip(),
            f"DSH_HOME        : {self.home}",
            f"profiles found  : {', '.join(self.profiles) if self.profiles else '(none — will assume \"{DEFAULT_PROFILE}\")'}",
            f"plugin          : {self.pkg_name}@{self.version}",
            f"repo dir        : {self.repo_dir}",
            f"github owner    : {self.owner or '(none — no origin remote; pass --owner for method C)'}",
        ]
        return lines

    def version_warning(self) -> str | None:
        """Yellow note when the installed dsh version is not the target. Warning
        only — never blocks, because behaviour may still work on other versions."""
        if not self.dsh_ver:
            return None
        if self.dsh_ver == TARGET_DSH_VERSION:
            return None
        return (_warn(f"Note: installed dsh is {self.dsh_ver}, this plugin is developed "
                      f"and verified against {TARGET_DSH_VERSION}. "
                      "Functionality on a different dsh version is not guaranteed."))


# ---------------------------------------------------------------------------
# command running
# ---------------------------------------------------------------------------

class Runner:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run

    def run(self, argv: list[str], cwd: pathlib.Path | None = None) -> int:
        cmd = " ".join(argv)
        log(_c(f"$ {cmd}"))
        if self.dry_run:
            log(_warn("  (dry-run — not executed)"))
            return 0
        res = subprocess.run(argv, cwd=str(cwd) if cwd else None)
        return res.returncode


# ---------------------------------------------------------------------------
# install actions
# ---------------------------------------------------------------------------

def plugin_argv(det: Detection, profile: str, sub: list[str]) -> list[str]:
    """Build the dsh plugin invocation (cross-platform)."""
    return [det.dsh_bin or "dsh", "plugin", "--profile", profile, *sub]


def build_tarball(det: Detection, runner: Runner, repo_dir: pathlib.Path) -> pathlib.Path:
    """Build <name>-<version>.tgz in repo_dir. Prefers npm pack; falls back to a
    pure-Python tar built from package.json's files field when npm is absent."""
    out = repo_dir / det.tgz_name
    if runner.dry_run:
        log(_warn(f"  (dry-run) would produce {out.name}"))
        return out
    if det.npm_bin:
        rc = runner.run([det.npm_bin, "pack", "--pack-destination", str(repo_dir)],
                        cwd=repo_dir)
        if rc == 0 and out.is_file():
            return out
        raise RuntimeError("npm pack failed")
    # ---- pure-python fallback (npm layout: files under 'package/') ----
    files_field = det.pkg.get("files", [])
    include = list(files_field) + ["package.json"]
    log(_warn("npm not found — building tarball with stdlib tarfile (files field)."))
    if out.exists():
        out.unlink()
    with tarfile.open(str(out), "w:gz") as tar:
        for rel in include:
            src = (repo_dir / rel).resolve()
            if not src.exists():
                log(_warn(f"  skip missing files entry: {rel}"))
                continue
            if src.is_dir():
                for f in sorted(src.rglob("*")):
                    if f.is_file():
                        arc = pathlib.Path("package") / f.relative_to(repo_dir)
                        tar.add(str(f), arcname=str(arc))
            else:
                arc = pathlib.Path("package") / src.relative_to(repo_dir)
                tar.add(str(src), arcname=str(arc))
    return out


def method_dev(det: Detection, runner: Runner, profile: str) -> int:
    log(f"\n=== Method A: dev symlink into profile '{profile}' ===")
    rc = runner.run(plugin_argv(det, profile, ["add", str(det.repo_dir)]))
    if rc == 0:
        log(_ok(f"Dev symlink installed. Restart `dsh {profile}` to load lib/index.js; "
                "a hard refresh loads client.js."))
    return rc


def method_tarball(det: Detection, runner: Runner, profile: str) -> int:
    log(f"\n=== Method B: tarball install into profile '{profile}' ===")
    if not (det.repo_dir / "package.json").is_file():
        log(_err("No package.json in repo dir; nothing to pack."))
        return 1
    tgz = build_tarball(det, runner, det.repo_dir)
    spec = f"file:{tgz}"
    log(_ok(f"Tarball ready: {tgz}"))
    rc = runner.run(plugin_argv(det, profile, ["add", spec]))
    if rc == 0:
        log(_ok(f"Tarball installed from {tgz}. Restart `dsh {profile}`."))
    return rc


def method_github(det: Detection, runner: Runner, profile: str, owner: str | None) -> int:
    spec = det.github_spec(owner)
    if spec is None:
        log(_err("Method C needs a GitHub owner. Pass --owner <user>, or set an "
                 "`origin` git remote on this checkout first."))
        return 1
    log(f"\n=== Method C: fetch {spec} from GitHub and install into profile '{profile}' ===")
    log(_warn("This clones the published repo from github.com and installs it as a "
              "package — the repo must be pushed to GitHub first."))
    rc = runner.run(plugin_argv(det, profile, ["add", spec]))
    if rc == 0:
        log(_ok(f"Installed {spec}. Restart `dsh {profile}`."))
    return rc


def method_uninstall(det: Detection, runner: Runner, profile: str) -> int:
    log(f"\n=== Uninstall '{det.pkg_name}' from profile '{profile}' ===")
    rc = runner.run(plugin_argv(det, profile, ["remove", det.pkg_name]))
    if rc == 0:
        log(_ok(f"Removed '{det.pkg_name}' (if it was present). Restart `dsh {profile}`."))
    return rc


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="install.py",
        description="Cross-platform installer for dsh-model-by-preset.",
    )
    ap.add_argument("--repo", default=None,
                    help="Path to the plugin checkout (default: directory of this script).")
    ap.add_argument("--profile", default=None,
                    help="DSH profile to install into (default: first found or 'web').")
    ap.add_argument("--method", choices=["A", "B", "C", "U"],
                    help="A=dev symlink, B=tarball, C=GitHub repo, U=uninstall. "
                         "If omitted, an interactive menu is shown.")
    ap.add_argument("--owner", default=None,
                    help="GitHub owner for method C (default: detected from this "
                         "checkout's origin git remote; required when there is none).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print the commands but do not run them.")
    ap.add_argument("--list", action="store_true",
                    help="Only print environment detection and exit.")
    ap.add_argument("--yes", action="store_true",
                    help="Skip the confirmation prompt before making changes.")
    return ap.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    repo_dir = pathlib.Path(args.repo) if args.repo else pathlib.Path(__file__).resolve().parent
    det = Detection(repo_dir)
    runner = Runner(dry_run=args.dry_run)

    log(_c("dsh-model-by-preset installer"))
    for line in det.toolchain_report():
        log("  " + line)
    if det.version_warning():
        log("  " + det.version_warning())

    if args.list:
        return 0

    if not det.dsh_bin:
        log(_err("dsh CLI not found on PATH — cannot manage profile plugins."))
        return 1
    if not det.pnpm_bin:
        log(_err("pnpm not found on PATH — `dsh plugin` forwards to pnpm (see dsh docs)."))
        return 1

    # pick a profile
    profile = args.profile or (det.profiles[0] if det.profiles else DEFAULT_PROFILE)
    log(_warn(f"\nTarget profile: {profile}"))

    if args.method is None:
        method = prompt_choice(
            "How do you want to install dsh-model-by-preset?",
            [
                ("A", "dev symlink (edit client.js / lib in place — fastest to iterate)"),
                ("B", "tarball (npm pack -> file:…tgz — self-contained install)"),
                ("C", "GitHub repo (fetch <owner>/<repo> from github.com — needs the repo pushed)"),
                ("U", "uninstall from the profile"),
            ],
        )
    else:
        method = args.method

    if not args.dry_run and not args.yes:
        if not ask_yes_no(f"Proceed with method {method} into profile '{profile}'?"):
            log("Aborted.")
            return 0

    if method == "A":
        return method_dev(det, runner, profile)
    if method == "B":
        return method_tarball(det, runner, profile)
    if method == "C":
        return method_github(det, runner, profile, args.owner or det.owner)
    if method == "U":
        return method_uninstall(det, runner, profile)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
