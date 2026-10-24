// Build the ready-to-upload zip for a release: only what a web server needs
// (the install guide's "What to copy" list) plus the licence notices, taken
// from the committed files (git archive), so the zip is exactly that commit.
//
//   npm run release:zip            -> royal-tasks-<version>.zip (version from package.json)
//   npm run release:zip -- v1.2.0  -> from that tag instead of HEAD
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ref = process.argv[2] || "HEAD";
const version = ref === "HEAD" ? pkg.version : ref.replace(/^v/, "");
const out = `royal-tasks-${version}.zip`;

// The runtime: the app shell, the API, the code, the assets (with the
// vendored libraries and their licences), the installer and the upgrader.
const paths = [
  "index.html", "manifest.json", "sw.js",
  "api", "assets", "src",
  "install.php", "upgrade.php", "config.example.php",
  "LICENSE", "NOTICE", "CREDITS.md",
];

execFileSync("git", ["archive", "--format=zip", `--prefix=royal-tasks/`, "-o", out, ref, "--", ...paths], { stdio: "inherit" });
console.log(`${out}: unzip it into the folder the app should be served from, then open install.php.`);
