require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const simpleGit = require("simple-git");
const fs = require("fs").promises;
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(bodyParser.json());

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_BASE_PATH = process.env.REPO_BASE_PATH || "./repos";
const git = simpleGit();

// Ensure REPO_BASE_PATH exists
(async () => {
    try {
        await fs.mkdir(REPO_BASE_PATH, { recursive: true });
    } catch (error) {
        console.error("❌ Failed to create repository base path:", error);
    }
})();

// Ensure GitHub token exists
if (!GITHUB_TOKEN) {
    console.error("❌ GitHub Token is missing! Add it to the .env file.");
    process.exit(1);
}

// Utility function to check valid repository path
const getRepoPath = (repoName) => path.resolve(REPO_BASE_PATH, repoName);

// 🔹 Clone Repository
app.post("/add-repo", async (req, res) => {
    const { repoUrl } = req.body;
    if (!repoUrl) return res.status(400).json({ success: false, message: "Repository URL is required." });

    const repoName = repoUrl.split("/").pop().replace(".git", "");
    const repoPath = getRepoPath(repoName);

    try {
        if (await fs.access(repoPath).then(() => true).catch(() => false)) {
            return res.json({ success: false, message: "Repository already exists." });
        }
        await git.clone(repoUrl, repoPath);
        res.json({ success: true, message: "Repository added successfully." });
    } catch (error) {
        console.error("Error cloning repository:", error);
        res.status(500).json({ success: false, error: "Failed to clone repository." });
    }
});

// 🔹 List Repositories
app.get("/list-repos", async (req, res) => {
    try {
        const repos = (await fs.readdir(REPO_BASE_PATH))
            .filter(async (repo) => (await fs.lstat(getRepoPath(repo))).isDirectory());
        res.json({ success: true, repos });
    } catch (error) {
        console.error("Error listing repositories:", error);
        res.status(500).json({ error: "Failed to list repositories" });
    }
});

// 🔹 Get Repository Files Securely
app.get("/repo-files", async (req, res) => {
    const { repoName, branchName } = req.query;
    if (!repoName || !branchName) {
        return res.status(400).json({ success: false, message: "Repository name and branch name are required." });
    }

    const repoPath = getRepoPath(repoName);
    const gitRepo = simpleGit(repoPath);

    try {
        await fs.access(repoPath);
        console.log(`🟢 Checking out branch: ${branchName}`);
        await gitRepo.checkout(branchName);
        await gitRepo.pull("origin", branchName); // Ensure latest changes

        const listFilesRecursively = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            return Promise.all(entries.map(async (entry) => ({
                name: entry.name,
                path: path.relative(repoPath, path.join(dir, entry.name)),
                type: entry.isDirectory() ? "folder" : "file",
                children: entry.isDirectory() ? await listFilesRecursively(path.join(dir, entry.name)) : [],
            })));
        };

        const files = await listFilesRecursively(repoPath);
        res.json({ success: true, files });

    } catch (error) {
        console.error("❌ Error listing repo files:", error);
        res.status(500).json({ success: false, error: "Failed to list repository files." });
    }
});

app.get("/file-content", async (req, res) => {
    const { repoName, branchName, filePath } = req.query;
    if (!repoName || !branchName || !filePath) {
        return res.status(400).json({ success: false, error: "Missing parameters!" });
    }

    const repoPath = getRepoPath(repoName);
    const gitRepo = simpleGit(repoPath);

    try {
        console.log(`🟢 Checking out branch: ${branchName}`);
        await gitRepo.checkout(branchName);
        await gitRepo.pull("origin", branchName); // Ensure latest changes

        const fullPath = path.resolve(repoPath, decodeURIComponent(filePath));
        if (!fullPath.startsWith(repoPath)) {
            return res.status(400).json({ success: false, error: "Invalid file path!" });
        }

        const content = await fs.readFile(fullPath, "utf8");
        res.json({ success: true, content });

    } catch (error) {
        console.error("❌ Error reading file:", error);
        res.status(500).json({ success: false, error: "File not found!" });
    }
});

// 🔹 List all branches (local + remote)
app.get("/list-branches", async (req, res) => {
    const { repoName } = req.query;
    if (!repoName) return res.status(400).json({ success: false, message: "Repository name is required." });

    try {
        const repoPath = getRepoPath(repoName);
        const gitRepo = simpleGit(repoPath);
        
        // Fetch latest remote branches
        await gitRepo.fetch();

        // Get all branches (local & remote)
        const branchSummary = await gitRepo.branch(["-a"]);
        let branches = Object.keys(branchSummary.branches);

        // Remove 'remotes/origin/' prefix for remote branches
        branches = branches.map(branch => branch.replace("remotes/origin/", ""));

        // Remove duplicates & sort
        branches = [...new Set(branches)].sort();

        res.json({ success: true, branches });
    } catch (error) {
        console.error("Error listing branches:", error);
        res.status(500).json({ success: false, error: "Failed to list branches." });
    }
});

// 🔹 Create and Push a New 
app.post("/create-branch", async (req, res) => {
    const { repoName, branchName } = req.body;
    if (!repoName || !branchName) return res.status(400).json({ success: false, message: "Repository name and branch name are required." });

    try {
        const repoPath = getRepoPath(repoName);
        const gitRepo = simpleGit(repoPath);

        // Fetch latest branches
        await gitRepo.fetch();

        // Get all branches (local & remote)
        const branchSummary = await gitRepo.branch(["-a"]);
        let branches = Object.keys(branchSummary.branches);

        // Check if branch exists remotely
        const remoteBranchExists = branches.some(branch => branch.includes(branchName));

        if (remoteBranchExists) {
            return res.json({ success: false, message: `Branch '${branchName}' already exists.` });
        }

        // Create and push new branch
        await gitRepo.checkoutLocalBranch(branchName);
        await gitRepo.push("origin", branchName);

        res.json({ success: true, message: `Branch '${branchName}' created and pushed.`, branch: branchName });
    } catch (error) {
        console.error("Error creating branch:", error);
        res.status(500).json({ success: false, error: "Failed to create branch." });
    }
});


// 🔹 Switch to an Existing Branch
app.post("/switch-branch", async (req, res) => {
    const { repoName, branchName } = req.body;
    if (!repoName || !branchName) return res.status(400).json({ success: false, message: "Repository name and branch name are required." });

    try {
        const repoPath = getRepoPath(repoName);
        const gitRepo = simpleGit(repoPath);

        // ✅ Checkout the branch
        await gitRepo.checkout(branchName);

        // ✅ Ensure it tracks the correct remote branch
        await gitRepo.branch(["--set-upstream-to=origin/" + branchName, branchName]);

        res.json({ success: true, message: `Switched to branch '${branchName}'.` });
    } catch (error) {
        console.error("Error switching branch:", error);
        res.status(500).json({ success: false, error: "Failed to switch branch." });
    }
});

// 🔹 Save File to Repository
app.post("/save-file", async (req, res) => {
    const { repoName, filePath, content } = req.body;
    if (!repoName || !filePath || content === undefined) {
        return res.status(400).json({ success: false, message: "Missing parameters!" });
    }

    try {
        const fullPath = path.resolve(getRepoPath(repoName), filePath);
        if (!fullPath.startsWith(getRepoPath(repoName))) return res.status(400).json({ success: false, error: "Invalid file path!" });

        await fs.writeFile(fullPath, content, "utf8");
        res.json({ success: true, message: "File saved successfully!" });
    } catch (error) {
        console.error("Error saving file:", error);
        res.status(500).json({ success: false, error: "Failed to save file." });
    }
});

// 🔹 Commit & Push Changes
app.post("/commit-push", async (req, res) => {
    const { repoName, branchName, commitMessage } = req.body;
    if (!repoName || !branchName || !commitMessage) {
        return res.status(400).json({ success: false, message: "Missing parameters!" });
    }

    try {
        const repoPath = getRepoPath(repoName);
        const gitRepo = simpleGit(repoPath);

        // ✅ Check for uncommitted changes
        const status = await gitRepo.status();
        if (!status.isClean()) {
            console.log("🟡 Uncommitted changes found. Stashing...");
            await gitRepo.add(["-A"]); // Stage all changes
            await gitRepo.commit(commitMessage); // Commit changes
        }

        // ✅ Ensure correct branch before pushing
        console.log(`🟢 Switching to branch: ${branchName}`);
        await gitRepo.checkout(branchName);

        // ✅ Pull latest changes
        try {
            await gitRepo.pull("origin", branchName);
        } catch (pullError) {
            console.error("Pull error:", pullError);
            return res.status(500).json({ success: false, error: "Failed to pull latest changes. Resolve conflicts before pushing." });
        }

        // ✅ Push changes
        console.log("🚀 Pushing to branch:", branchName);
        await gitRepo.push("origin", branchName);

        res.json({ success: true, message: `Changes committed and pushed to '${branchName}'!` });

    } catch (error) {
        console.error("Error committing and pushing:", error);
        res.status(500).json({ success: false, error: "Failed to commit and push changes." });
    }
});

// 🔹 Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));

// UI is displaying as per the way I want             ---> this displays branches in options and on selecting and commit and push button it pushes the changes to the MAIN branch instred of the selected branch