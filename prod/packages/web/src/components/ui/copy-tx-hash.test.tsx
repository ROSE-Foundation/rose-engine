// @vitest-environment jsdom
import '../../test/setup.js';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CopyTxHash } from './copy-tx-hash.js';

describe('CopyTxHash', () => {
  it('copies the full hash to the clipboard and confirms', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const hash = '0xabcdef0123456789abcdef0123456789abcdef01';

    render(<CopyTxHash hash={hash} />);
    await userEvent.click(screen.getByRole('button', { name: `Copy transaction hash ${hash}` }));

    expect(writeText).toHaveBeenCalledWith(hash);
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
  });

  it('shows an explicit no-tx state when there is no hash (never blank)', () => {
    render(<CopyTxHash hash={null} />);
    expect(screen.getByText('No on-chain tx')).toBeInTheDocument();
  });
});
