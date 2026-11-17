const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * 1. LOAD USER PROFILE & CAREER-OPS CONFIGURATION
 */
function loadProfile() {
  const profilePath = path.join(__dirname, 'profile.json');
  if (fs.existsSync(profilePath)) {
    try {
      return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
    } catch (e) {
      console.warn("⚠️ Failed to parse profile.json, using built-in defaults.");
    }
  }
  return {
    personal: { fullName: "Applicant", location: "Kochi" },
    preferences: {
      targetTitles: ["Software Engineer", "Full Stack Developer", "Backend Developer", "React Developer", "Android Developer"],
      excludedKeywords: ["Senior Staff", "Lead", "Principal", "Manager", "10+ years"],
      minFitScore: 50
    },
    skills: { defaultYears: 1, yearsOfExperience: {} },
    screeningAnswers: { workAuthorization: "Yes", requireSponsorship: "No", noticePeriodDays: "0" }
  };
}

function getResumePath() {
  const specificFile = path.join(__dirname, 'ADWAITH_KK_Resume(2).pdf');
  if (fs.existsSync(specificFile)) return specificFile;

  const defaultFile = path.join(__dirname, 'resume.pdf');
  if (fs.existsSync(defaultFile)) return defaultFile;

  try {
    const files = fs.readdirSync(__dirname);
    const pdf = files.find(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('.'));
    if (pdf) return path.join(__dirname, pdf);
  } catch (e) {}

  return null;
}

const PROFILE = loadProfile();
const RESUME_FILE = getResumePath();

const CONFIG = {
  keyword: 'Software Engineer',
  location: 'Kochi',          // Matches your local jobs
  easyApplyOnly: true,        // Adds 'f_AL=true' to URL
  maxJobsToScrape: 15,        // Max jobs to scrape per search page
  processEasyApply: true,     // Whether to process Easy Apply flow
  maxApplicationsPerRun: 2,   // Max applications to inspect per execution
  dryRun: true,               // SAFETY SWITCH: If true, never clicks final Submit
  resumePath: RESUME_FILE,    // Auto-detected resume file
  minDelayMs: 1200,
  maxDelayMs: 2500,
};

// Helpers: Human-like delay
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min = CONFIG.minDelayMs, max = CONFIG.maxDelayMs) =>
  sleep(Math.floor(Math.random() * (max - min + 1)) + min);

function ensureOutputDir() {
  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * 2. CAREER-OPS FIT SCORING ENGINE
 */
function calculateFitScore(job, profile) {
  let score = 50; // Base score
  const reasons = [];
  const titleLower = (job.title || '').toLowerCase();

  // A. Check Excluded Keywords (Dealbreakers)
  for (const excluded of (profile.preferences.excludedKeywords || [])) {
    if (titleLower.includes(excluded.toLowerCase())) {
      score -= 50;
      reasons.push(`Contains excluded keyword: "${excluded}"`);
      break;
    }
  }

  // B. Check Target Titles
  let titleMatched = false;
  for (const target of (profile.preferences.targetTitles || [])) {
    if (titleLower.includes(target.toLowerCase())) {
      score += 30;
      reasons.push(`Matches target title: "${target}"`);
      titleMatched = true;
      break;
    }
  }
  if (!titleMatched) {
    score -= 10;
  }

  // C. Skill Alignment Check
  const skills = profile.skills?.yearsOfExperience || {};
  let matchedSkillsCount = 0;
  for (const skill of Object.keys(skills)) {
    if (titleLower.includes(skill.toLowerCase())) {
      score += 10;
      matchedSkillsCount++;
    }
  }
  if (matchedSkillsCount > 0) {
    reasons.push(`Matched ${matchedSkillsCount} skill(s) in title`);
  }

  score = Math.max(0, Math.min(100, score));

  let rating = 1;
  if (score >= 80) rating = 5;
  else if (score >= 65) rating = 4;
  else if (score >= 50) rating = 3;
  else if (score >= 35) rating = 2;

  const passed = score >= (profile.preferences.minFitScore || 50);

  return {
    score,
    rating: `${rating}/5 ⭐`,
    passed,
    reasons: reasons.join('; ') || 'Standard match'
  };
}

/**
 * 3. APPLICATION TRACKER
 */
function updateTracker(job, fitResult, status) {
  const outputDir = ensureOutputDir();
  const trackerPath = path.join(outputDir, 'applications_tracker.json');

  let tracker = [];
  if (fs.existsSync(trackerPath)) {
    try {
      tracker = JSON.parse(fs.readFileSync(trackerPath, 'utf-8'));
    } catch (e) {
      tracker = [];
    }
  }

  const existingIndex = tracker.findIndex(item => item.id === job.id);
  const entry = {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    link: job.link,
    fitScore: fitResult.score,
    fitRating: fitResult.rating,
    fitReasons: fitResult.reasons,
    status: status,
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    tracker[existingIndex] = entry;
  } else {
    tracker.push(entry);
  }

  fs.writeFileSync(trackerPath, JSON.stringify(tracker, null, 2), 'utf-8');
}

/**
 * 4. LAZY LOADING SCROLL HANDLER
 */
async function scrollJobList(page) {
  console.log("Scrolling left results container to trigger lazy loading of all jobs...");
  for (let step = 1; step <= 6; step++) {
    await page.evaluate(() => {
      // Find all scrollable containers on the left side of the page
      const allEls = Array.from(document.querySelectorAll('*'));
      let scrolled = false;
      for (const el of allEls) {
        const style = window.getComputedStyle(el);
        const isScrollable = (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        const rect = el.getBoundingClientRect();
        if (isScrollable && rect.left < window.innerWidth * 0.6 && rect.width > 200) {
          el.scrollBy({ top: 600, behavior: 'smooth' });
          scrolled = true;
          break;
        }
      }
      if (!scrolled) {
        window.scrollBy({ top: 600, behavior: 'smooth' });
      }
    });
    await randomDelay(800, 1200);
  }
}

/**
 * 5. BULLETPROOF JOB CARD EXTRACTION
 * Specifically captures items from the left results column.
 */
async function extractJobs(page) {
  console.log("Extracting job listings from the left results pane...");

  // Diagnostic: Inspect DOM elements on the left side
  const extractionResult = await page.evaluate(() => {
    const results = [];
    const debug = {};

    // 1. Locate the left column container (holds the search results list)
    // On LinkedIn, the left results container is on the left half of the screen
    const leftElements = Array.from(document.querySelectorAll('*')).filter(el => {
      const rect = el.getBoundingClientRect();
      const isLeft = rect.left < window.innerWidth * 0.55 && rect.width > 220 && rect.height > 200;
      const isNotDetail = !el.closest('.jobs-search__job-details') && !el.closest('.scaffold-layout__detail');
      return isLeft && isNotDetail;
    });

    // 2. Find list items or job card wrappers
    let cards = [];
    
    // Strategy A: Direct list items
    const listItems = Array.from(document.querySelectorAll(
      'ul.scaffold-layout__list-container > li, ' +
      'li.scaffold-layout__list-item, ' +
      'li.jobs-search-results__list-item, ' +
      'li[data-occludable-job-id], ' +
      'div[data-job-id], ' +
      'div.job-card-container'
    )).filter(c => {
      const rect = c.getBoundingClientRect();
      return rect.left < window.innerWidth * 0.55 && !c.closest('.jobs-search__job-details') && !c.closest('.scaffold-layout__detail');
    });

    if (listItems.length > 0) {
      cards = listItems;
      debug.strategy = `Strategy A (listItems: ${listItems.length})`;
    } else {
      // Strategy B: Find elements containing 'Easy Apply' or job links
      const jobAnchors = Array.from(document.querySelectorAll('a')).filter(a => {
        const href = a.href || '';
        const rect = a.getBoundingClientRect();
        const isLeft = rect.left < window.innerWidth * 0.55 && !a.closest('.jobs-search__job-details') && !a.closest('.scaffold-layout__detail');
        return isLeft && (href.includes('/jobs/view/') || href.includes('currentJobId='));
      });
      cards = [...new Set(jobAnchors.map(a => a.closest('li') || a.parentElement).filter(Boolean))];
      debug.strategy = `Strategy B (anchors: ${jobAnchors.length}, cards: ${cards.length})`;
    }

    debug.totalCardsFound = cards.length;

    cards.forEach((card, index) => {
      const text = card.innerText || '';
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      if (lines.length === 0) return;

      // Filter out footer text
      const firstLineLower = lines[0].toLowerCase();
      if (firstLineLower === 'about' || firstLineLower === 'accessibility' || firstLineLower === 'help center' || firstLineLower.includes('job alert')) {
        return;
      }

      // Extract Job ID
      const linkEl = card.querySelector('a[href*="/jobs/view/"], a[href*="currentJobId="]') || card.querySelector('a');
      const href = linkEl ? linkEl.href : '';
      const idMatch = href.match(/\/jobs\/view\/(\d+)/) ||
                      href.match(/currentJobId=(\d+)/) ||
                      card.getAttribute('data-job-id')?.match(/(\d+)/) ||
                      card.getAttribute('data-occludable-job-id')?.match(/(\d+)/);
      const jobId = idMatch ? idMatch[1] : `job-${index}`;

      // Extract Title:
      // Try explicit title element first
      let title = '';
      const titleEl = card.querySelector('.job-card-list__title, a[class*="title"], strong, [class*="job-title"]');
      if (titleEl) {
        title = titleEl.innerText.split('\n')[0].trim();
      } else {
        // Line 0 is the job title
        title = lines[0];
      }
      title = title.replace(/\s+/g, ' ');

      if (!title || title.length < 3 || title.toLowerCase() === 'more') return;

      // Extract Company:
      let company = 'N/A';
      const companyEl = card.querySelector('a[href*="/company/"], [class*="primary-description"], [class*="company"]');
      if (companyEl) {
        company = (companyEl.innerText || '').split('\n')[0].trim();
      } else if (lines.length >= 2) {
        // Line 1 is company if not a badge
        const candidate = lines[1];
        if (!candidate.includes('Apply') && !candidate.includes('Promoted') && !candidate.includes('Actively') && candidate.length < 50) {
          company = candidate;
        }
      }

      // Extract Location:
      let location = 'N/A';
      const locationEl = card.querySelector('[class*="secondary-description"], [class*="metadata"], [class*="caption"]');
      if (locationEl) {
        location = (locationEl.innerText || '').split('\n')[0].trim();
      } else if (lines.length >= 3) {
        // Line 2 is location if not a badge
        const candidate = lines[2];
        if (!candidate.includes('Apply') && !candidate.includes('Promoted') && !candidate.includes('Actively') && candidate.length < 60) {
          location = candidate;
        }
      }

      // Easy Apply Check
      const hasEasyApply = text.includes('Easy Apply') ||
                           !!card.querySelector('[class*="apply-method"], svg.linkedin-bug-icon');

      const canonicalLink = idMatch ? `https://www.linkedin.com/jobs/view/${jobId}/` : href;

      results.push({
        id: jobId,
        title,
        company,
        location,
        link: canonicalLink,
        isEasyApply: hasEasyApply
      });
    });

    // Deduplicate by Job ID
    const unique = [];
    const seen = new Set();
    for (const r of results) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        unique.push(r);
      }
    }

    return { jobs: unique, debug };
  });

  console.log(`DOM Extraction Info: ${extractionResult.debug.strategy} | Found ${extractionResult.debug.totalCardsFound} raw cards`);
  return extractionResult.jobs;
}

/**
 * 6. SAVE RESULTS TO CSV AND JSON
 */
function saveResults(jobs) {
  const outputDir = ensureOutputDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sanitizedKeyword = CONFIG.keyword.toLowerCase().replace(/[^a-z0-9]/g, '_');

  const jsonPath = path.join(outputDir, `jobs_${sanitizedKeyword}_${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jobs, null, 2), 'utf-8');
  console.log(`📁 Saved JSON: ${jsonPath}`);

  const csvPath = path.join(outputDir, `jobs_${sanitizedKeyword}_${timestamp}.csv`);
  const csvHeaders = 'ID,Title,Company,Location,EasyApply,FitRating,FitScore,Link\n';
  const csvRows = jobs.map(j => {
    const safeTitle = `"${(j.title || '').replace(/"/g, '""')}"`;
    const safeCompany = `"${(j.company || '').replace(/"/g, '""')}"`;
    const safeLocation = `"${(j.location || '').replace(/"/g, '""')}"`;
    return `${j.id},${safeTitle},${safeCompany},${safeLocation},${j.isEasyApply},"${j.fitRating || ''}",${j.fitScore || 0},${j.link}`;
  }).join('\n');

  fs.writeFileSync(csvPath, csvHeaders + csvRows, 'utf-8');
  console.log(`📊 Saved CSV: ${csvPath}`);
}

/**
 * 7. SCREENING FORM AUTO-FILLER
 */
async function fillScreeningForm(page, profile) {
  const modal = await page.$('div.jobs-easy-apply-modal, div[role="dialog"]');
  if (!modal) return;

  // A. Text & Number Inputs
  const textInputs = await modal.$$('input[type="text"], input[type="number"], input:not([type]), textarea');
  for (const input of textInputs) {
    const isVisible = await input.isVisible().catch(() => false);
    if (!isVisible) continue;

    const currentVal = await input.inputValue().catch(() => '');
    if (currentVal.trim() !== '') continue;

    const id = await input.getAttribute('id');
    const labelText = id ? await page.$eval(`label[for="${id}"]`, el => el.innerText).catch(() => '') : '';
    const ariaLabel = await input.getAttribute('aria-label') || '';
    const prompt = `${labelText} ${ariaLabel}`.toLowerCase();

    // Experience question
    if (prompt.includes('experience') || prompt.includes('how many years')) {
      let matchedYears = profile.skills.defaultYears || 1;
      const skills = profile.skills.yearsOfExperience || {};
      for (const [skill, yrs] of Object.entries(skills)) {
        if (prompt.includes(skill.toLowerCase())) {
          matchedYears = yrs;
          break;
        }
      }
      console.log(`  Filling experience field ("${labelText.substring(0, 40)}..."): ${matchedYears}`);
      await input.fill(String(matchedYears));
      await randomDelay(300, 600);
      continue;
    }

    // Notice Period
    if (prompt.includes('notice period')) {
      const notice = profile.screeningAnswers.noticePeriodDays || '0';
      console.log(`  Filling notice period: ${notice}`);
      await input.fill(String(notice));
      await randomDelay(300, 600);
      continue;
    }

    // Phone
    if (prompt.includes('phone') || prompt.includes('mobile')) {
      if (profile.personal.phone) {
        console.log(`  Filling phone number: ${profile.personal.phone}`);
        await input.fill(profile.personal.phone);
        await randomDelay(300, 600);
      }
      continue;
    }

    // City
    if (prompt.includes('city') || prompt.includes('location')) {
      if (profile.personal.city) {
        console.log(`  Filling city: ${profile.personal.city}`);
        await input.fill(profile.personal.city);
        await randomDelay(300, 600);
      }
      continue;
    }
  }

  // B. Radio Buttons
  const fieldsets = await modal.$$('fieldset');
  for (const fieldset of fieldsets) {
    const legendText = await fieldset.$eval('legend', el => el.innerText).catch(() => '');
    const prompt = legendText.toLowerCase();
    if (!prompt) continue;

    const checked = await fieldset.$('input[type="radio"]:checked');
    if (checked) continue;

    let targetAnswer = null;
    if (prompt.includes('authorized to work') || prompt.includes('legally authorized') || prompt.includes('work authorization')) {
      targetAnswer = profile.screeningAnswers.workAuthorization || 'Yes';
    } else if (prompt.includes('sponsorship') || prompt.includes('require visa')) {
      targetAnswer = profile.screeningAnswers.requireSponsorship || 'No';
    } else if (prompt.includes('relocate') || prompt.includes('relocation')) {
      targetAnswer = profile.screeningAnswers.willingToRelocate || 'Yes';
    } else if (prompt.includes('commute') || prompt.includes('on-site') || prompt.includes('hybrid')) {
      targetAnswer = profile.screeningAnswers.comfortableWithCommute || 'Yes';
    } else if (prompt.includes('background check') || prompt.includes('drug test')) {
      targetAnswer = 'Yes';
    }

    if (targetAnswer) {
      const radio = await fieldset.$(`label:has-text("${targetAnswer}"), input[value="${targetAnswer}"]`);
      if (radio) {
        console.log(`  Selecting radio for "${legendText.substring(0, 40)}...": ${targetAnswer}`);
        await radio.click().catch(() => {});
        await randomDelay(400, 800);
      }
    }
  }

  // C. Dropdowns
  const selects = await modal.$$('select');
  for (const select of selects) {
    const isVisible = await select.isVisible().catch(() => false);
    if (!isVisible) continue;

    const id = await select.getAttribute('id');
    const labelText = id ? await page.$eval(`label[for="${id}"]`, el => el.innerText).catch(() => '') : '';
    const prompt = labelText.toLowerCase();

    if (prompt.includes('sponsorship')) {
      await select.selectOption({ label: profile.screeningAnswers.requireSponsorship || 'No' }).catch(() => {});
    } else if (prompt.includes('authorized')) {
      await select.selectOption({ label: profile.screeningAnswers.workAuthorization || 'Yes' }).catch(() => {});
    }
  }
}

/**
 * 8. SAFE EASY APPLY PROCESSOR
 */
async function handleEasyApply(page, job, profile) {
  console.log(`\n==================================================`);
  console.log(`🎯 Evaluating Job: "${job.title}" at "${job.company}"`);
  console.log(`   Fit Score: ${job.fitRating} (${job.fitScore}/100) | Reason: ${job.fitReasons}`);
  console.log(`==================================================`);

  if (!job.fitPassed) {
    console.log(`⏩ Skipping job: Fit score (${job.fitScore}) is below minimum threshold (${profile.preferences.minFitScore}).`);
    updateTracker(job, { score: job.fitScore, rating: job.fitRating, reasons: job.fitReasons }, 'SKIPPED_LOW_FIT');
    return;
  }

  // Click the job card in results
  const cardSelector = `[data-job-id="${job.id}"], li[data-occludable-job-id="${job.id}"], a[href*="${job.id}"]`;
  const card = await page.$(cardSelector);

  if (card) {
    await card.scrollIntoViewIfNeeded();
    await randomDelay(600, 1000);
    await card.click();
  } else if (job.link && job.link.startsWith('http')) {
    await page.goto(job.link);
  }

  await randomDelay(1800, 2600);

  // Look for Easy Apply button
  const applyButtonSelectors = [
    'button.jobs-apply-button',
    '.jobs-search__job-details button:has-text("Easy Apply")',
    'button[data-job-id]:has-text("Easy Apply")',
    'button:has-text("Easy Apply")'
  ];

  let applyBtn = null;
  for (const selector of applyButtonSelectors) {
    applyBtn = await page.$(selector);
    if (applyBtn) break;
  }

  if (!applyBtn) {
    console.log("ℹ️  No 'Easy Apply' button visible (might require applying on external company site).");
    updateTracker(job, { score: job.fitScore, rating: job.fitRating, reasons: job.fitReasons }, 'EXTERNAL_APPLY_ONLY');
    return;
  }

  console.log("Found 'Easy Apply' button! Opening modal...");
  await applyBtn.click();
  await randomDelay(1500, 2200);

  const modalSelector = 'div.jobs-easy-apply-modal, div[role="dialog"]';
  try {
    await page.waitForSelector(modalSelector, { timeout: 8000 });
  } catch (e) {
    console.log("Application modal did not open. Skipping.");
    return;
  }

  console.log("Modal opened successfully. Navigating steps with auto-filler...");

  let finalStatus = 'REVIEWED_DRY_RUN';

  // Multi-step loop (max 6 steps)
  for (let step = 1; step <= 6; step++) {
    await randomDelay(1200, 1800);

    // 1. Auto-fill screening questions in current step
    await fillScreeningForm(page, profile);

    // 2. Handle Resume upload if file input exists
    const fileInput = await page.$('input[type="file"]');
    if (fileInput) {
      if (CONFIG.resumePath && fs.existsSync(CONFIG.resumePath)) {
        console.log(`📄 Found file upload input. Uploading resume: ${CONFIG.resumePath}`);
        await fileInput.setInputFiles(CONFIG.resumePath);
        await randomDelay(1500, 2000);
      } else {
        console.log("📄 Resume input detected. Using default resume saved on your profile.");
      }
    }

    // 3. Inspect Next / Review / Submit buttons
    const submitBtn = await page.$('button[aria-label="Submit application"], button:has-text("Submit application")');
    const reviewBtn = await page.$('button[aria-label="Review your application"], button:has-text("Review")');
    const nextBtn = await page.$('button[aria-label="Continue to next step"], button:has-text("Next")');

    if (submitBtn) {
      console.log(`Step ${step}: Reached final 'Submit application' button.`);
      if (CONFIG.dryRun) {
        console.log("🛡️  [DRY RUN] Aborting submission to keep your profile safe.");
        finalStatus = 'READY_TO_SUBMIT_DRY_RUN';
      } else {
        console.log("🚀 Submitting application...");
        await submitBtn.click();
        await randomDelay(2000, 3000);
        finalStatus = 'APPLIED';
      }
      break;
    } else if (reviewBtn) {
      console.log(`Step ${step}: Found 'Review' button. Advancing to review...`);
      await reviewBtn.click();
    } else if (nextBtn) {
      console.log(`Step ${step}: Found 'Next' button. Advancing to next step...`);
      await nextBtn.click();
    } else {
      console.log(`Step ${step}: No Next/Review/Submit button detected.`);
      break;
    }
  }

  // Dismiss modal
  console.log("Closing application modal...");
  const dismissBtn = await page.$('button[aria-label="Dismiss"], button.artdeco-modal__dismiss');
  if (dismissBtn) {
    await dismissBtn.click();
    await randomDelay(800, 1200);

    const discardBtn = await page.$('button[data-control-name="discard_application_confirm_btn"], button:has-text("Discard")');
    if (discardBtn) {
      await discardBtn.click();
      await randomDelay(600, 1000);
    }
  }

  updateTracker(job, { score: job.fitScore, rating: job.fitRating, reasons: job.fitReasons }, finalStatus);
}

/**
 * MAIN ORCHESTRATOR
 */
async function runJobHunter() {
  const userDataDir = path.join(__dirname, 'my-safe-session');
  const outputDir = ensureOutputDir();

  console.log("==================================================");
  console.log("🤖 Starting Playwright Job Hunter (career-ops powered)");
  console.log(`Keyword: "${CONFIG.keyword}" | Location: "${CONFIG.location}"`);
  console.log(`Target Titles: ${PROFILE.preferences.targetTitles.slice(0, 3).join(', ')}...`);
  console.log(`Resume: ${CONFIG.resumePath ? path.basename(CONFIG.resumePath) : 'LinkedIn Default'}`);
  console.log(`Min Fit Score: ${PROFILE.preferences.minFitScore} | Dry Run: ${CONFIG.dryRun}`);
  console.log("==================================================\n");

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1366, height: 850 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox'
    ]
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    // 1. Build search URL
    let searchUrl = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(CONFIG.keyword)}&location=${encodeURIComponent(CONFIG.location)}`;
    if (CONFIG.easyApplyOnly) {
      searchUrl += '&f_AL=true';
    }

    console.log(`Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    await randomDelay(3000, 4000);

    console.log(`Current URL: ${page.url()}`);
    console.log(`Page Title: "${await page.title()}"`);

    // Wait for job listings to render on screen
    console.log("Waiting for job listings to load from LinkedIn...");
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('li[data-occludable-job-id], .scaffold-layout__list-item, [class*="job-card"], a[href*="/jobs/view/"], a[href*="currentJobId="]');
      return items.length >= 3;
    }, { timeout: 15000 }).catch(() => console.log("Proceeding to scroll..."));

    // 2. Handle Lazy Loading
    await scrollJobList(page);
    await randomDelay(1500, 2500);

    // Save a visual snapshot of the page after scrolling
    const pageScreenshot = path.join(outputDir, 'current_page_view.png');
    await page.screenshot({ path: pageScreenshot, fullPage: false });
    console.log(`📸 Current page view saved to: ${pageScreenshot}`);

    // Dump page HTML snippet for inspection
    try {
      const pageInfo = await page.evaluate(() => {
        const headerEl = document.querySelector('h1, [class*="results-count"], small');
        const headerText = headerEl ? headerEl.innerText.trim() : 'No header text';
        const cardCount = document.querySelectorAll('li, div[data-job-id]').length;
        return { headerText, cardCount };
      });
      console.log(`LinkedIn Page Status: "${pageInfo.headerText}" (DOM elements: ${pageInfo.cardCount})`);
    } catch (e) {}

    // 3. Extract Job Listings
    let jobs = await extractJobs(page);
    console.log(`\n🎉 Extracted ${jobs.length} job(s) from this page.`);

    if (jobs.length === 0) {
      console.log("⚠️  0 jobs were extracted. Saving a debug screenshot...");
      const debugScreenshot = path.join(outputDir, 'debug_no_jobs.png');
      await page.screenshot({ path: debugScreenshot, fullPage: false });
      console.log(`📸 Screenshot saved to: ${debugScreenshot}`);
    } else {
      // 4. Calculate career-ops Fit Score for each job
      for (const job of jobs) {
        const fit = calculateFitScore(job, PROFILE);
        job.fitScore = fit.score;
        job.fitRating = fit.rating;
        job.fitReasons = fit.reasons;
        job.fitPassed = fit.passed;
      }

      if (jobs.length > CONFIG.maxJobsToScrape) {
        jobs = jobs.slice(0, CONFIG.maxJobsToScrape);
      }

      // Display summary table with fit scores
      console.table(jobs.map(j => ({
        Title: j.title.substring(0, 25),
        Company: j.company.substring(0, 18),
        Location: j.location.substring(0, 16),
        Fit: j.fitRating,
        Score: j.fitScore,
        Passed: j.fitPassed ? '✅' : '❌',
        EasyApply: j.isEasyApply
      })));

      // Save to JSON & CSV
      saveResults(jobs);

      // 5. Automated Easy Apply for High-Fit Jobs Only
      if (CONFIG.processEasyApply) {
        const highFitJobs = jobs
          .filter(j => j.isEasyApply && j.fitPassed)
          .slice(0, CONFIG.maxApplicationsPerRun);

        console.log(`\nFiltered ${highFitJobs.length} high-fit job(s) for Easy Apply (Max: ${CONFIG.maxApplicationsPerRun})...`);

        for (const job of highFitJobs) {
          await handleEasyApply(page, job, PROFILE);
          await randomDelay(2500, 4000);
        }
      }
    }

    console.log("\n✅ Job Hunter execution completed successfully!");
    console.log(`📊 Check output/applications_tracker.json to view your tracked pipeline.`);
  } catch (error) {
    console.error("❌ An error occurred during execution:", error);
  } finally {
    console.log("Leaving session open for 5 seconds before closing...");
    await sleep(5000);
    await context.close();
  }
}

runJobHunter();
