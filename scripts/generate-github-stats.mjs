// Generate private-aware GitHub profile stat cards as local SVG files.
import { mkdir, writeFile } from "node:fs/promises";

// Configure constants for GitHub API calls and output paths.
const token = process.env.GH_STATS_TOKEN;
const username = process.env.GITHUB_USERNAME || "lagoon5223";
const now = new Date();
const from = new Date(now);
from.setFullYear(now.getFullYear() - 1);

if (!token) {
  throw new Error("GH_STATS_TOKEN is required. Add it as a GitHub Actions secret.");
}

// Escape dynamic text before embedding it inside SVG markup.
function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// Call GitHub REST or GraphQL endpoints with the private-read token.
async function githubFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API failed: ${response.status} ${url}\n${body}`);
  }

  return response.json();
}

// Query contribution totals through GraphQL so private contributions can be included for the token owner.
async function getContributionStats() {
  const query = `
    query($from: DateTime!, $to: DateTime!) {
      viewer {
        login
        name
        followers {
          totalCount
        }
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
          }
          restrictedContributionsCount
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
          totalPullRequestReviewContributions
        }
      }
    }
  `;

  const data = await githubFetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/json"
    },
    body: JSON.stringify({
      query,
      variables: {
        from: from.toISOString(),
        to: now.toISOString()
      }
    })
  });

  if (data.errors) {
    throw new Error(JSON.stringify(data.errors, null, 2));
  }

  return data.data.viewer;
}

// Fetch every repository the token can read, including private repositories owned by the user.
async function getAllRepos() {
  const repos = [];
  let page = 1;

  while (true) {
    const batch = await githubFetch(
      `https://api.github.com/user/repos?visibility=all&affiliation=owner&per_page=100&page=${page}&sort=updated`
    );

    repos.push(...batch);

    if (batch.length < 100) {
      break;
    }

    page += 1;
  }

  return repos.filter((repo) => !repo.fork && repo.owner?.login?.toLowerCase() === username.toLowerCase());
}

// Aggregate repository language byte counts across public and private repositories.
async function getLanguageTotals(repos) {
  const totals = new Map();

  for (const repo of repos) {
    const languages = await githubFetch(repo.languages_url);

    for (const [language, bytes] of Object.entries(languages)) {
      totals.set(language, (totals.get(language) || 0) + bytes);
    }
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
}

// Convert a number into a compact display value.
function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

// Render the main stats card as an SVG file.
function renderStatsSvg({ viewer, repos }) {
  const displayName = viewer.name || viewer.login;
  const collection = viewer.contributionsCollection;
  const totalContributions = collection.contributionCalendar.totalContributions;
  const commits = collection.totalCommitContributions;
  const prs = collection.totalPullRequestContributions;
  const issues = collection.totalIssueContributions;
  const reviews = collection.totalPullRequestReviewContributions;
  const privateCount = collection.restrictedContributionsCount;
  const privateRepos = repos.filter((repo) => repo.private).length;

  const rows = [
    ["Total Contributions", formatNumber(totalContributions)],
    [`Total Commits (${now.getFullYear()})`, formatNumber(commits)],
    ["Pull Requests", formatNumber(prs)],
    ["Issues Opened", formatNumber(issues)],
    ["Code Reviews", formatNumber(reviews)],
    ["Private Contributions", formatNumber(privateCount)],
    ["Public Repos", formatNumber(repos.length - privateRepos)],
    ["Private Repos", formatNumber(privateRepos)],
    ["Followers", formatNumber(viewer.followers.totalCount)]
  ];

  const rowMarkup = rows
    .map(
      ([label, value], index) => `
        <text x="40" y="${80 + index * 24}" class="label">${escapeXml(label)}:</text>
        <text x="470" y="${80 + index * 24}" class="value">${escapeXml(value)}</text>`
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="520" height="300" viewBox="0 0 520 300" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(displayName)}'s GitHub Stats</title>
  <desc id="desc">Private-aware GitHub contribution statistics generated by GitHub Actions.</desc>
  <style>
    .title { font: 700 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #c792ea; }
    .label { font: 500 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #82aaff; }
    .value { font: 700 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #b2ccd6; text-anchor: end; }
    .accent { fill: #89ddff; opacity: 0.9; }
  </style>
  <rect x="0.5" y="0.5" width="519" height="299" rx="8" fill="#1b1e2b" stroke="#82aaff"/>
  <text x="40" y="42" class="title">${escapeXml(displayName)}'s GitHub Stats</text>
  ${rowMarkup}
</svg>
`;
}

// Render the language chart as an SVG file.
function renderLanguagesSvg(languages) {
  const total = languages.reduce((sum, [, bytes]) => sum + bytes, 0) || 1;
  const colors = ["#f1e05a", "#e34c26", "#3178c6", "#3572A5", "#563d7c", "#00ADD8", "#dea584", "#89e051"];

  let offset = 0;
  const bars = languages
    .map(([language, bytes], index) => {
      const width = Math.max((bytes / total) * 440, 2);
      const segment = `<rect x="${40 + offset}" y="70" width="${width}" height="12" rx="6" fill="${colors[index % colors.length]}"/>`;
      offset += width;
      return segment;
    })
    .join("");

  const rows = languages
    .map(([language, bytes], index) => {
      const x = 42 + (index % 2) * 230;
      const y = 122 + Math.floor(index / 2) * 34;
      const percent = ((bytes / total) * 100).toFixed(1);

      return `
        <circle cx="${x}" cy="${y - 4}" r="6" fill="${colors[index % colors.length]}"/>
        <text x="${x + 18}" y="${y}" class="lang">${escapeXml(language)} ${percent}%</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="520" height="300" viewBox="0 0 520 300" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">Most Used Languages</title>
  <desc id="desc">Private-aware language usage generated from accessible repositories.</desc>
  <style>
    .title { font: 700 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #c792ea; }
    .lang { font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #82aaff; }
  </style>
  <rect x="0.5" y="0.5" width="519" height="299" rx="8" fill="#1b1e2b" stroke="#82aaff"/>
  <text x="40" y="42" class="title">Most Used Languages</text>
  ${bars}
  ${rows}
</svg>
`;
}

// Generate and write both SVG assets.
async function main() {
  const viewer = await getContributionStats();

  if (viewer.login.toLowerCase() !== username.toLowerCase()) {
    throw new Error(`Token belongs to ${viewer.login}, but GITHUB_USERNAME is ${username}.`);
  }

  const repos = await getAllRepos();
  const languages = await getLanguageTotals(repos);

  await mkdir("assets", { recursive: true });
  await writeFile("assets/github-stats.svg", renderStatsSvg({ viewer, repos }), "utf8");
  await writeFile("assets/github-langs.svg", renderLanguagesSvg(languages), "utf8");

  console.log(`Generated stats for ${viewer.login}: ${repos.length} repos, ${languages.length} languages.`);
}

await main();
