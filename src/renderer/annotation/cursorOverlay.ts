// Some pages paint their own highlighted pointer into the desktop pixels.
// Accept a compact pointer core only when it has a surrounding tinted halo on a flat background.
export function clearPointerHalo(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    atX: number,
    atY: number,
    scale: number,
) {
    const counts = new Map<number, number>();
    let best = 0,
        background = 0,
        samples = 0;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            if (x && y && x !== width - 1 && y !== height - 1) continue;
            const i = 4 * (y * width + x);
            const key = pixels[i] * 65536 + pixels[i + 1] * 256 + pixels[i + 2];
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            samples++;
            if (count > best) {
                best = count;
                background = key;
            }
        }
    if (best < samples * 0.48) return false;
    const bg = [background >>> 16, (background >> 8) & 255, background & 255];
    const strong = new Uint8Array(width * height),
        core = new Uint8Array(strong.length);
    let start = -1,
        distance = (10 * scale) ** 2;
    for (let i = 0; i < strong.length; i++) {
        strong[i] = Number(
            bg.some((c, k) => Math.abs(c - pixels[4 * i + k]) > 115),
        );
        if (!strong[i]) continue;
        const d = ((i % width) - atX) ** 2 + (Math.floor(i / width) - atY) ** 2;
        if (d <= distance) {
            start = i;
            distance = d;
        }
    }
    if (start === -1) return false;
    const queue = [start];
    let left = width,
        right = 0,
        top = height,
        bottom = 0;
    core[start] = 1;
    for (let k = 0; k < queue.length; k++) {
        const i = queue[k],
            x = i % width,
            y = Math.floor(i / width);
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        for (
            let ny = Math.max(0, y - 1);
            ny <= Math.min(height - 1, y + 1);
            ny++
        )
            for (
                let nx = Math.max(0, x - 1);
                nx <= Math.min(width - 1, x + 1);
                nx++
            ) {
                const n = ny * width + nx;
                if (strong[n] && !core[n]) {
                    core[n] = 1;
                    queue.push(n);
                }
            }
    }
    const w = right - left + 1,
        h = bottom - top + 1,
        density = queue.length / (w * h);
    if (
        Math.min(w, h) < 5 * scale ||
        Math.max(w, h) > 36 * scale ||
        density < 0.25 ||
        density > 0.89
    )
        return false;
    const cx = (left + right) / 2,
        cy = (top + bottom) / 2;
    // A circular plot marker, even with a glow, has a balanced silhouette.
    let offsetX = 0,
        offsetY = 0;
    for (const i of queue) {
        offsetX += (i % width) - cx;
        offsetY += Math.floor(i / width) - cy;
    }
    if (Math.hypot(offsetX / w, offsetY / h) < queue.length * 0.065)
        return false;
    function tint(x: number, y: number) {
        x = Math.round(x);
        y = Math.round(y);
        if (x < 0 || x >= width || y < 0 || y >= height) return 0;
        const i = (y * width + x) * 4;
        const r = pixels[i] - bg[0],
            g = pixels[i + 1] - bg[1],
            b = pixels[i + 2] - bg[2];
        return Math.max(Math.abs(r), Math.abs(g), Math.abs(b)) < 105
            ? Math.max(r, g, b) - Math.min(r, g, b)
            : 0;
    }
    let rays = 0;
    for (let k = 0; k < 8; k++) {
        const dx = Math.cos((k * Math.PI) / 4),
            dy = Math.sin((k * Math.PI) / 4);
        const near = tint(
            cx + dx * (w / 2 + 3 * scale),
            cy + dy * (h / 2 + 3 * scale),
        );
        const far = tint(
            cx + dx * (w / 2 + 19 * scale),
            cy + dy * (h / 2 + 19 * scale),
        );
        if (near >= 7 && near >= far + 3) rays++;
    }
    if (rays < 5) return false;
    // Preserve nearby letters and their antialiasing even if the halo crosses them.
    const guard = new Uint8Array(strong.length);
    const pad = Math.ceil(1.5 * scale);
    for (let i = 0; i < strong.length; i++)
        if (strong[i] && !core[i]) {
            const x = i % width,
                y = Math.floor(i / width);
            for (
                let row = Math.max(0, y - pad);
                row <= Math.min(height - 1, y + pad);
                row++
            )
                guard.fill(
                    1,
                    row * width + Math.max(0, x - pad),
                    row * width + Math.min(width, x + pad + 1),
                );
        }
    for (let i = 0; i < strong.length; i++) {
        const x = i % width,
            y = Math.floor(i / width);
        if (
            guard[i] ||
            Math.hypot(x - cx, y - cy) > Math.max(w, h) / 2 + 21 * scale
        )
            continue;
        if (
            core[i] ||
            (x >= left - pad &&
                x <= right + pad &&
                y >= top - pad &&
                y <= bottom + pad) ||
            tint(x, y) > 1
        )
            for (let k = 0; k < 3; k++) pixels[4 * i + k] = bg[k];
    }
    return true;
}

export function pointerPatch(
    source: HTMLCanvasElement,
    pointer: { x: number; y: number },
    scale: number,
) {
    const radius = Math.ceil(48 * scale);
    const x = Math.max(0, Math.floor(pointer.x - radius)),
        y = Math.max(0, Math.floor(pointer.y - radius));
    const width = Math.min(source.width - x, radius * 2),
        height = Math.min(source.height - y, radius * 2);
    if (width < 1 || height < 1) return;
    const original = source.getContext("2d")!.getImageData(x, y, width, height);
    const clean = new ImageData(
        new Uint8ClampedArray(original.data),
        width,
        height,
    );
    if (
        !clearPointerHalo(
            clean.data,
            width,
            height,
            pointer.x - x,
            pointer.y - y,
            scale,
        )
    )
        return;
    const tile = document.createElement("canvas");
    tile.width = width;
    tile.height = height;
    tile.getContext("2d")!.putImageData(clean, 0, 0);
    return { x, y, original, tile };
}
