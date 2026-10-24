<?php
declare(strict_types=1);

/**
 * Someone else changed the record between the client reading it and writing
 * it back. The write was refused; the caller gets the record as it actually
 * is now, so the client can show the current state instead of silently
 * overwriting the other person's work.
 */
final class VersionConflict extends RuntimeException
{
    /** @param array<string,mixed> $current the record as stored right now */
    public function __construct(
        public array $current,
        public int $storedVersion,
        public int $expectedVersion,
        string $message = 'This board was changed somewhere else. Your change was not saved.'
    ) {
        parent::__construct($message, 409);
    }
}
