import { describe, it, expect } from 'vitest';
import { paginate } from './paginate.js';

describe('paginate', () => {
  const dataset = ['item1', 'item2', 'item3', 'item4', 'item5', 'item6', 'item7'];

  it('returns the first page of items correctly', () => {
    const result = paginate(dataset, 1, 3);
    expect(result.items).toEqual(['item1', 'item2', 'item3']);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(3);
    expect(result.total).toBe(7);
    expect(result.totalPages).toBe(3);
  });
});
