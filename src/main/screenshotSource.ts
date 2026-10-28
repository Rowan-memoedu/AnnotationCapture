export function screenshotSource<T extends { display_id: string }>(
    displayId: number,
    displayCount: number,
    sources: T[],
) {
    return (
        sources.find((source) => source.display_id === String(displayId)) ??
        (displayCount === 1 &&
        sources.length === 1 &&
        sources[0].display_id === ""
            ? sources[0]
            : undefined)
    );
}
