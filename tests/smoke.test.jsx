import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const TestComponent = () => <div>Hello Vitest</div>;

describe('Smoke Test', () => {
    it('should pass basic assertion', () => {
        expect(1 + 1).toBe(2);
    });

    it('should render react component', () => {
        render(<TestComponent />);
        expect(screen.getByText('Hello Vitest')).toBeInTheDocument();
    });
});
