import { describe, it, expect, vi } from 'vitest';
import Logger from '../packages/core/src/logger.js';
import AppError from '../packages/core/src/errors.js';

describe('Logger', () => {
    it('should call console.info', () => {
        const spy = vi.spyOn(console, 'info');
        Logger.info('Test Info');
        expect(spy).toHaveBeenCalledWith('[INFO] Test Info', '');
        spy.mockRestore();
    });

    it('should call console.error', () => {
        const spy = vi.spyOn(console, 'error');
        Logger.error('Test Error');
        expect(spy).toHaveBeenCalledWith('[ERROR] Test Error', '');
        spy.mockRestore();
    });
});

describe('AppError', () => {
    it('should create an instance with defaults', () => {
        const err = new AppError('Something went wrong');
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe('Something went wrong');
        expect(err.code).toBe('INTERNAL_ERROR');
        expect(err.status).toBe(500);
    });

    it('should create an instance with custom properties', () => {
        const err = new AppError('Invalid input', 'VALIDATION_ERROR', 400, { field: 'email' });
        expect(err.message).toBe('Invalid input');
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.status).toBe(400);
        expect(err.meta).toEqual({ field: 'email' });
    });
});
