export class NanitesError extends Error {
    code;
    retryable;
    details;
    constructor(shape) {
        super(shape.message);
        this.name = "NanitesError";
        this.code = shape.code;
        this.retryable = shape.retryable;
        this.details = shape.details;
    }
    toShape() {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            ...(this.details ? { details: this.details } : {}),
        };
    }
}
