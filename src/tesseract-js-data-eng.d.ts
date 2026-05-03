// gestament - TypeScript based test driver for GTK.
// Copyright (c) Kouji Matsui. (@kekyo@mi.kekyo.net)
// Under MIT.
// https://github.com/kekyo/gestament

declare module '@tesseract.js-data/eng' {
  interface EnglishLanguageData {
    readonly code: 'eng';
    readonly gzip: boolean;
    readonly langPath: string;
  }

  const data: EnglishLanguageData;
  export = data;
}
