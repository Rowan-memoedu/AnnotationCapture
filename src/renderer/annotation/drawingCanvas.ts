import { Canvas, type TPointerEvent } from "fabric";
import { PressureBrush } from "./pressureBrush";

function pointerEvent(type: "pointerdown" | "pointerup", sample: PointerEvent) {
    return new PointerEvent(type, {
        pointerId: sample.pointerId,
        pointerType: sample.pointerType,
        isPrimary: sample.isPrimary,
        clientX: sample.clientX,
        clientY: sample.clientY,
        shiftKey: sample.shiftKey,
        button: 0,
        buttons: type === "pointerdown" ? 1 : 0,
        pressure: type === "pointerdown" ? sample.pressure : 0,
    });
}

export class DrawingCanvas extends Canvas {
    private contact?: PointerEvent;
    private pendingContact?: PointerEvent;
    private otherPresses = new Set<number>();

    constructor(
        element: string,
        options: ConstructorParameters<typeof Canvas>[1],
    ) {
        super(element, options);
        const upper = this.upperCanvasEl;
        document.addEventListener(
            "pointerdown",
            (event) => {
                if (
                    event.button === 0 &&
                    (event.target !== upper || !this.isDrawingMode)
                )
                    this.otherPresses.add(event.pointerId);
            },
            true,
        );
        const release = (event: PointerEvent) => {
            this.otherPresses.delete(event.pointerId);
            if (event.pointerId === this.pendingContact?.pointerId)
                this.pendingContact = undefined;
        };
        document.addEventListener("pointerup", release, true);
        document.addEventListener(
            "pointercancel",
            (event) => {
                release(event);
                if (event.pointerId === this.contact?.pointerId)
                    this.finishStroke(undefined, true);
            },
            true,
        );
        upper.addEventListener("lostpointercapture", (event) => {
            if (event.pointerId === this.contact?.pointerId)
                this.finishStroke();
        });
        window.addEventListener("blur", () => {
            this.otherPresses.clear();
            this.finishStroke();
        });
    }

    get hasStroke() {
        return this.contact !== undefined;
    }

    override _isMainEvent(event: TPointerEvent) {
        // Fabric and its brushes must accept every sample from the pen that
        // owns the stroke, even when Chromium marks it non-primary.
        return (
            (event instanceof PointerEvent &&
                this.contact?.pointerId === event.pointerId) ||
            super._isMainEvent(event)
        );
    }

    override _onMouseDown(event: TPointerEvent) {
        if (!(event instanceof PointerEvent) || !this.isDrawingMode) {
            super._onMouseDown(event);
            return;
        }
        if (event.button !== 0 || !canDraw(event)) return;
        if (this.contact && this.contact.pointerId !== event.pointerId) {
            this.otherPresses.add(event.pointerId);
            return;
        }
        this.finishStroke();
        this.startStroke(event);
    }

    override _onMouseMove(event: TPointerEvent) {
        if (event instanceof PointerEvent) {
            const pressed = (event.buttons & 1) !== 0;
            if (!pressed) {
                this.otherPresses.delete(event.pointerId);
                if (event.pointerId === this.pendingContact?.pointerId)
                    this.pendingContact = undefined;
            }
            if (this.contact) {
                if (event.pointerId !== this.contact.pointerId) return;
                if (!pressed) this.finishStroke();
                else this.contact = event;
            } else if (
                this.isDrawingMode &&
                pressed &&
                canDraw(event) &&
                event.target === this.upperCanvasEl &&
                !this.otherPresses.has(event.pointerId)
            ) {
                const initial = this.pendingContact;
                this.pendingContact = event;
                // Recover a missed down after consecutive pressed moves. A lone
                // move before a real down must not become an extra dot.
                if (initial?.pointerId === event.pointerId) {
                    this.pendingContact = undefined;
                    this.startStroke(
                        event,
                        pointerEvent("pointerdown", initial),
                    );
                }
            }
        }
        super._onMouseMove(event);
    }

    override _onMouseUp(event: TPointerEvent) {
        if (!(event instanceof PointerEvent) || !this.contact) {
            super._onMouseUp(event);
            return;
        }
        // Fabric releases its document move/up listeners on a primary release.
        // Keep them attached until the owner lifts.
        if (event.pointerId !== this.contact.pointerId || event.buttons & 1)
            return;
        this.finishStroke(event.button === 0 ? event : undefined);
    }

    private startStroke(event: PointerEvent, down = event) {
        this.otherPresses.delete(event.pointerId);
        this.contact = event;
        if (event.isTrusted) {
            try {
                this.upperCanvasEl.setPointerCapture(event.pointerId);
            } catch (error) {
                if (
                    !(error instanceof DOMException) ||
                    error.name !== "NotFoundError"
                )
                    throw error;
                // Fabric's document listeners can still receive the stroke.
            }
        }
        super._onMouseDown(down);
    }

    finishStroke(event?: PointerEvent, cancelled = false) {
        this.pendingContact = undefined;
        const contact = this.contact;
        if (!contact) return;
        if (cancelled && this.freeDrawingBrush instanceof PressureBrush) {
            this.freeDrawingBrush.cancel();
            this._isCurrentlyDrawing = false;
        }
        try {
            super._onMouseUp(event ?? pointerEvent("pointerup", contact));
        } finally {
            this.contact = undefined;
            const upper = this.upperCanvasEl;
            if (upper.hasPointerCapture(contact.pointerId))
                upper.releasePointerCapture(contact.pointerId);
            upper.dispatchEvent(new Event("ac-stroke-end"));
        }
    }
}

function canDraw(event: PointerEvent) {
    return event.isPrimary || event.pointerType === "pen";
}
