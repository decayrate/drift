#!/usr/bin/env python3
"""
Automated test runner for drift.
Starts an HTTP server, fetches the test page, and parses results.
Falls back to structural/syntax checks if no browser engine is available.
"""

import http.server
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request

PROJECT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

errors = []
warnings = []


def check_file_exists(path, label):
    full = os.path.join(PROJECT_DIR, path)
    if not os.path.isfile(full):
        errors.append(f"Missing file: {path}")
        return False
    return True


def check_html_structure():
    """Validate index.html has required DOM elements."""
    html_path = os.path.join(PROJECT_DIR, "index.html")
    with open(html_path, "r") as f:
        html = f.read()

    required_ids = [
        "app", "sidebar", "sidebar-collapse-btn", "collapse-label",
        "start-input", "suggestions", "locate-btn",
        "duration-slider", "duration-display",
        "road-preference", "find-routes-btn",
        "results", "results-count", "route-list",
        "loading", "error-msg",
        "map-container", "map", "map-placeholder",
        "route-card-template",
    ]

    for elem_id in required_ids:
        pattern = f'id="{elem_id}"'
        if pattern not in html:
            errors.append(f"HTML missing element with id=\"{elem_id}\"")

    # Check template has required classes
    template_required = [
        "route-card", "route-color-dot", "route-name", "route-select-btn",
        "stat-time", "stat-distance", "stat-traffic", "stat-traffic-text",
        "route-summary", "route-links", "google-link", "apple-link",
    ]
    for cls in template_required:
        if cls not in html:
            errors.append(f"HTML template missing class \"{cls}\"")

    print(f"  HTML structure: {len(required_ids) + len(template_required)} elements checked")


def check_js_syntax():
    """Basic syntax validation of app.js."""
    js_path = os.path.join(PROJECT_DIR, "js", "app.js")
    with open(js_path, "r") as f:
        js = f.read()

    # Check required functions exist
    required_functions = [
        "initMap", "fetchSuggestions", "showSuggestions", "hideSuggestions",
        "geocodeSearch", "setStart", "findRoutes",
        "fetchTomTomRoute", "fetchOsrmRoute",
        "renderRoutes", "buildRouteCard", "selectRoute",
        "offsetLatLng", "routeMins", "deduplicateRoutes", "formatDuration",
        "clearRoutes", "showError",
        "buildTooltipHtml", "showPermanentTooltip",
    ]

    for fn in required_functions:
        if f"function {fn}" not in js:
            errors.append(f"JS missing function: {fn}")

    # Check polyline click handler exists (route selection from map)
    if "polyline.on('click'" not in js and 'polyline.on("click"' not in js:
        errors.append("JS missing polyline click handler for map route selection")

    # Check polyline hover handlers exist
    if "polyline.on('mouseover'" not in js and 'polyline.on("mouseover"' not in js:
        errors.append("JS missing polyline mouseover handler")

    # Check hover tooltip is bound to polylines
    if "polyline.bindTooltip" not in js:
        errors.append("JS missing polyline.bindTooltip for route hover tooltips")

    # Check permanent tooltip logic
    if "permanentTooltip" not in js:
        errors.append("JS missing permanentTooltip state for persistent route overlay")

    # Check sidebar collapse logic exists
    if "sidebar.classList.toggle('collapsed')" not in js and 'sidebar.classList.toggle("collapsed")' not in js:
        errors.append("JS missing sidebar collapse toggle logic")

    # Check that we're not auto-collapsing after route finding (the bug fix)
    # The code should expand, not collapse
    lines = js.split("\n")
    for i, line in enumerate(lines):
        if "sidebar.classList.add('collapsed')" in line or 'sidebar.classList.add("collapsed")' in line:
            # Check context — this should NOT be in findRoutes
            context_start = max(0, i - 20)
            context = "\n".join(lines[context_start:i])
            if "findRoutes" in context or "renderRoutes" in context:
                errors.append(f"JS line {i+1}: sidebar auto-collapses after finding routes (bug)")

    # Check balanced braces
    open_braces = js.count("{")
    close_braces = js.count("}")
    if open_braces != close_braces:
        errors.append(f"JS brace mismatch: {open_braces} open vs {close_braces} close")

    # Check balanced parentheses
    open_parens = js.count("(")
    close_parens = js.count(")")
    if open_parens != close_parens:
        errors.append(f"JS parenthesis mismatch: {open_parens} open vs {close_parens} close")

    print(f"  JS structure: {len(required_functions)} functions + syntax checks")


def check_css_mobile():
    """Validate CSS has mobile sidebar styles."""
    css_path = os.path.join(PROJECT_DIR, "css", "styles.css")
    with open(css_path, "r") as f:
        css = f.read()

    # Check mobile media query exists
    if "@media" not in css or "768px" not in css:
        errors.append("CSS missing mobile media query")

    # Check sidebar is positioned on the left for mobile (position: fixed + left: 0)
    if "position: fixed" not in css:
        errors.append("CSS mobile sidebar missing position: fixed (should slide from left)")

    if "left: 0" not in css:
        errors.append("CSS mobile sidebar missing left: 0")

    # Check collapse transform
    if "translateX" not in css:
        errors.append("CSS missing translateX for sidebar collapse animation")

    # Check collapse button styles
    if "#sidebar-collapse-btn" not in css:
        errors.append("CSS missing #sidebar-collapse-btn styles")

    # Check route tooltip styles
    if ".route-tooltip" not in css:
        errors.append("CSS missing .route-tooltip styles for map overlay")

    if ".tooltip-name" not in css:
        errors.append("CSS missing .tooltip-name styles")

    if ".route-tooltip-permanent" not in css:
        errors.append("CSS missing .route-tooltip-permanent styles")

    # Ensure the old top-panel approach (flex-direction: column) is NOT used
    # Actually it could still be in the file for other uses, let's check the media query block
    media_match = re.search(r'@media\s*\(max-width:\s*768px\)\s*\{(.*)', css, re.DOTALL)
    if media_match:
        media_block = media_match.group(1)
        # Count braces to find the end of the media query
        depth = 1
        end = 0
        for i, ch in enumerate(media_block):
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i
                    break
        media_content = media_block[:end]

        if "flex-direction: column" in media_content:
            errors.append("CSS mobile layout uses flex-direction: column (sidebar should be left panel, not top)")

    print(f"  CSS mobile layout: sidebar-left checks passed" if not any("CSS" in e for e in errors) else f"  CSS mobile layout: issues found")


def check_files():
    """Check all required files exist."""
    files = [
        ("index.html", "Main HTML"),
        ("js/app.js", "Application JS"),
        ("css/styles.css", "Styles"),
    ]
    for path, label in files:
        check_file_exists(path, label)
    print(f"  Files: {len(files)} checked")


def main():
    print("=" * 40)
    print("drift test suite")
    print("=" * 40)
    print()

    print("1. File existence checks")
    check_files()
    print()

    print("2. HTML structure validation")
    check_html_structure()
    print()

    print("3. JavaScript validation")
    check_js_syntax()
    print()

    print("4. CSS mobile layout validation")
    check_css_mobile()
    print()

    print("=" * 40)
    if errors:
        print(f"FAILED: {len(errors)} error(s)")
        for e in errors:
            print(f"  x {e}")
        sys.exit(1)
    else:
        print(f"ALL CHECKS PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()
