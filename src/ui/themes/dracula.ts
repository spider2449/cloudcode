import type { ThemeJson } from "../themeJson.js";

const theme: ThemeJson = {
  "$schema": "https://opencode.ai/theme.json",
  "defs": {
    "background": "#282a36",
    "currentLine": "#44475a",
    "selection": "#44475a",
    "foreground": "#f8f8f2",
    "comment": "#6272a4",
    "cyan": "#8be9fd",
    "green": "#50fa7b",
    "orange": "#ffb86c",
    "pink": "#ff79c6",
    "purple": "#bd93f9",
    "red": "#ff5555",
    "yellow": "#f1fa8c"
  },
  "theme": {
    "primary": {
      "dark": "purple",
      "light": "purple"
    },
    "secondary": {
      "dark": "pink",
      "light": "pink"
    },
    "accent": {
      "dark": "cyan",
      "light": "cyan"
    },
    "error": {
      "dark": "red",
      "light": "red"
    },
    "warning": {
      "dark": "yellow",
      "light": "yellow"
    },
    "success": {
      "dark": "green",
      "light": "green"
    },
    "info": {
      "dark": "orange",
      "light": "orange"
    },
    "text": {
      "dark": "foreground",
      "light": "#282a36"
    },
    "textMuted": {
      "dark": "comment",
      "light": "#6272a4"
    },
    "background": {
      "dark": "#282a36",
      "light": "#f8f8f2"
    },
    "backgroundPanel": {
      "dark": "#21222c",
      "light": "#e8e8e2"
    },
    "backgroundElement": {
      "dark": "currentLine",
      "light": "#d8d8d2"
    },
    "border": {
      "dark": "currentLine",
      "light": "#c8c8c2"
    },
    "borderActive": {
      "dark": "purple",
      "light": "purple"
    },
    "borderSubtle": {
      "dark": "#191a21",
      "light": "#e0e0e0"
    },
    "diffHunkHeader": {
      "dark": "comment",
      "light": "#6272a4"
    },
    "diffAddedBg": {
      "dark": "#1a3a1a",
      "light": "#e0ffe0"
    },
    "diffRemovedBg": {
      "dark": "#3a1a1a",
      "light": "#ffe0e0"
    },
    "diffLineNumber": {
      "dark": "#989aa4",
      "light": "#686865"
    },
    "diffAddedLineNumberBg": {
      "dark": "#1a3a1a",
      "light": "#e0ffe0"
    },
    "diffRemovedLineNumberBg": {
      "dark": "#3a1a1a",
      "light": "#ffe0e0"
    },
    "markdownHeading": {
      "dark": "purple",
      "light": "purple"
    },
    "markdownLink": {
      "dark": "cyan",
      "light": "cyan"
    },
    "markdownLinkText": {
      "dark": "pink",
      "light": "pink"
    },
    "markdownStrong": {
      "dark": "orange",
      "light": "orange"
    },
    "markdownHorizontalRule": {
      "dark": "comment",
      "light": "#6272a4"
    },
    "markdownImage": {
      "dark": "cyan",
      "light": "cyan"
    },
    "markdownImageText": {
      "dark": "pink",
      "light": "pink"
    },
    "syntaxKeyword": {
      "dark": "pink",
      "light": "pink"
    },
    "syntaxFunction": {
      "dark": "green",
      "light": "green"
    },
    "syntaxVariable": {
      "dark": "foreground",
      "light": "#282a36"
    },
    "syntaxString": {
      "dark": "yellow",
      "light": "yellow"
    },
    "syntaxNumber": {
      "dark": "purple",
      "light": "purple"
    },
    "syntaxType": {
      "dark": "cyan",
      "light": "cyan"
    },
    "syntaxOperator": {
      "dark": "pink",
      "light": "pink"
    }
  }
};

export default theme;
