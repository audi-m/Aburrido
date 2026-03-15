# AutoApply AI — Chrome Extension

AI-powered job application agent for LinkedIn Easy Apply and Indeed Quick Apply.
Uses Claude AI to accurately answer application questions based on your profile.

---

## 🚀 Installation (2 minutes)

1. **Download** and unzip this folder somewhere permanent (e.g. `C:\AutoApplyAI\`)

2. **Open Chrome** and go to: `chrome://extensions`

3. **Enable Developer Mode** (toggle in top-right corner)

4. Click **"Load unpacked"** → select the `extension/` folder

5. The AutoApply AI icon appears in your Chrome toolbar ✅

---

## ⚙️ Setup

### 1. Get a Claude API Key (free tier available)
- Go to [console.anthropic.com](https://console.anthropic.com)
- Create an account → API Keys → Create Key
- Copy the key (starts with `sk-ant-api03-...`)

### 2. Configure the extension
- Click the AutoApply AI icon in Chrome toolbar
- Paste your API key → click **Save**
- Set your **daily limit** (recommended: 30-40)
- Set your **minimum salary** (e.g. 120000)

---

## 🤖 How to Use

### LinkedIn Easy Apply
1. Go to [linkedin.com/jobs](https://linkedin.com/jobs)
2. Search for your job title (e.g. "Solutions Architect")
3. Click the AutoApply AI icon → **Start Autopilot**
4. Watch it apply automatically!

### Indeed Quick Apply
1. Go to [indeed.com/jobs](https://indeed.com/jobs)
2. Search for your job title
3. Click the AutoApply AI icon → **Start Autopilot**

### Dashboard
Click the grid icon in the popup to open the full dashboard with:
- Application history table
- 7-day bar chart
- Platform split stats
- Filter by platform/status

---

## 🧠 How AI Question Answering Works

When the application has a question like:
- *"How many years of experience with Kubernetes?"*
- *"Does this salary align with your expectations?"*
- *"Are you authorized to work in the US?"*

The extension reads the question and sends it to Claude along with your LinkedIn profile data.
Claude returns the precise answer based on YOUR actual background.

**Your LinkedIn profile is read locally** from the page — it never leaves your browser except to go to the Anthropic API to answer questions.

---

## ⚠️ Tips for Best Results

- Keep **HEADLESS** as false (visible browser) to handle any verification prompts
- Set a **reasonable daily limit** (30-40) to avoid LinkedIn flagging your account
- The extension applies only to **Easy Apply** jobs on LinkedIn — external apply links are skipped
- For best accuracy, make sure your **LinkedIn profile is fully filled out**

---

## 📁 File Structure

```
extension/
├── manifest.json           # Chrome extension config
├── background/
│   └── service_worker.js   # Coordinates everything, calls Claude API
├── content/
│   ├── ai_helper.js        # Shared AI utilities
│   ├── linkedin.js         # LinkedIn automation
│   └── indeed.js           # Indeed automation
├── popup/
│   ├── popup.html          # Extension popup UI
│   └── popup.js            # Popup logic
├── dashboard/
│   └── dashboard.html      # Full dashboard page
└── icons/                  # Extension icons
```
