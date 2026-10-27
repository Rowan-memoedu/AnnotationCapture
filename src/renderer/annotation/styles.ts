import { addStyle } from "dkh-ui";

export function annotationStyles() {
    addStyle({
        ":root": {
            "--ac-error-color": "#c43b36",
            "--ac-success-color": "#168346",
        },
        ".ac-button": {
            padding: "8px 14px",
            borderRadius: "var(--border-radius, 8px)",
            background: "var(--bar-bg)",
            border: "1px solid #8994a866",
            cursor: "pointer",
            font: "inherit",
        },
        ".ac-button:hover": {
            background: "var(--emphasis-color)",
            color: "var(--font-color-emphasis)",
        },
        ".ac-button:focus-visible, .ac-field:focus-visible": {
            outline: "3px solid var(--emphasis-color)",
            outlineOffset: "3px",
        },
        ".ac-button:active": { transform: "translateY(1px)" },
        ".ac-button:disabled": { opacity: "0.5", cursor: "wait" },
        ".ac-primary": {
            background: "var(--emphasis-color)",
            color: "var(--font-color-emphasis)",
        },
        ".ac-field": {
            width: "100%",
            border: "1px solid #8994a866",
            padding: "10px",
            borderRadius: "8px",
            background: "var(--bg)",
            color: "var(--font-color)",
            font: "inherit",
        },
        ".ac-field:hover": { background: "var(--bar-bg)" },
        ".ac-field[aria-invalid='true']": {
            borderColor: "var(--ac-error-color)",
        },
        ".ac-field:disabled": { opacity: "0.5", cursor: "not-allowed" },
        ".ac-error": { color: "var(--ac-error-color)" },
        ".ac-success": { color: "var(--ac-success-color)" },
        ".ac-overlay": {
            position: "fixed",
            inset: "0",
            zIndex: "100000",
            background: "var(--bg)",
            color: "var(--font-color)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "16px",
            padding: "24px",
        },
        ".ac-toolbar": {
            position: "fixed",
            right: "20px",
            bottom: "20px",
            zIndex: "10000",
            display: "flex",
            gap: "8px",
            alignItems: "center",
            padding: "10px",
            borderRadius: "12px",
            background: "var(--bg)",
            boxShadow: "0 2px 16px #0003",
        },
        ".ac-status": {
            whiteSpace: "pre-wrap",
            lineHeight: "1.6",
            maxWidth: "70ch",
        },
        ".ac-card": {
            padding: "20px",
            border: "1px solid #8994a844",
            borderRadius: "12px",
            display: "flex",
            flexDirection: "column",
            gap: "12px",
        },
    });
}
