module.exports = {
    appId: "edu.memo.annotationcapture",
    productName: "AnnotationCapture",
    executableName: "AnnotationCapture",
    copyright: "eSearch contributors and AnnotationCapture contributors",
    directories: { app: `${process.env.ANNOTATION_ARTIFACTS || "D:/Artifacts/AnnotationCapture"}/package`, output: `${process.env.ANNOTATION_ARTIFACTS || "D:/Artifacts/AnnotationCapture"}/release` },
    files: ["out/**/*", "assets/logo/**/*", "lib/translate/*.json", "package.json", "LICENSE", "README.md", "README.eSearch.md", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES.txt", "!node_modules/**/*"],
    asar: true,
    npmRebuild: false,
    electronVersion: "44.9.3",
    win: { icon: "assets/logo/icon.ico", target: ["zip"], signAndEditExecutable: false },
    artifactName: "AnnotationCapture-${version}-windows-x64.${ext}",
};
