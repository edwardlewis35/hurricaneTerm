//! Keep command and connection input literal within this app only.
//! No global macOS preference domain, keyboard hook, or IME interception.

#[cfg(any(target_os = "macos", test))]
const DISABLED_DEFAULTS: &[&str] = &[
    "NSAutomaticCapitalizationEnabled",
    "NSAutomaticSpellingCorrectionEnabled",
    "NSAutomaticTextReplacementEnabled",
    "NSAutomaticQuoteSubstitutionEnabled",
    "NSAutomaticDashSubstitutionEnabled",
    "NSAutomaticPeriodSubstitutionEnabled",
];

// Tauri installs this before the HTML is parsed, on every main-frame load.
// Mutation callbacks change only differing attributes, so our own updates do
// not keep the observer active. Never change values, selection, or IME events.
#[cfg(any(target_os = "macos", test))]
const WEBVIEW_SCRIPT: &str = r#"
(() => {
  if (window.__huricanoLiteralInputInstalled) return;
  window.__huricanoLiteralInputInstalled = true;
  const selector = 'input,textarea,[contenteditable]:not([contenteditable="false"])';
  const attributes = { autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' };
  const apply = element => {
    if (!element || element.nodeType !== 1) return;
    if (element !== document.documentElement && !element.matches(selector)) return;
    for (const [name, value] of Object.entries(attributes)) {
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
  };
  const scan = node => {
    if (!node) return;
    apply(node);
    if (node.querySelectorAll) node.querySelectorAll(selector).forEach(apply);
  };
  scan(document);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') apply(record.target);
      else record.addedNodes.forEach(scan);
    }
  }).observe(document, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['autocapitalize', 'autocorrect', 'spellcheck', 'contenteditable']
  });
  document.addEventListener('focusin', event => apply(event.target), true);
})();
"#;

/// Run before AppKit creates the WebView. standardUserDefaults writes to the
/// current application's domain, never NSGlobalDomain or another application.
pub fn configure() {
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSString, NSUserDefaults};
        let defaults = NSUserDefaults::standardUserDefaults();
        for key in DISABLED_DEFAULTS {
            defaults.setBool_forKey(false, &NSString::from_str(key));
        }
    }
}

#[cfg(target_os = "macos")]
pub fn init<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("literal-text-input")
        .js_init_script(WEBVIEW_SCRIPT)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_are_only_text_automation_flags() {
        assert_eq!(DISABLED_DEFAULTS.len(), 6);
        assert!(DISABLED_DEFAULTS.iter().all(|key| key.starts_with("NSAutomatic") && key.ends_with("Enabled")));
        let unique: std::collections::HashSet<_> = DISABLED_DEFAULTS.iter().collect();
        assert_eq!(unique.len(), DISABLED_DEFAULTS.len());
    }

    #[test]
    fn webview_policy_covers_dynamic_inputs_without_keyboard_interception() {
        for required in ["autocapitalize: 'none'", "autocorrect: 'off'", "spellcheck: 'false'", "MutationObserver", "contenteditable", "focusin"] {
            assert!(WEBVIEW_SCRIPT.contains(required));
        }
        for forbidden in ["preventDefault", "keydown", "keyup", "composition", ".value =", "selectionStart"] {
            assert!(!WEBVIEW_SCRIPT.contains(forbidden));
        }
    }
}
