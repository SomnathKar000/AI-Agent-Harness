export interface PaginationResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function paginate<T>(items: T[], page: number, pageSize: number): PaginationResult<T> {
  if (page < 1) {
    throw new Error('Page must be greater than or equal to 1');
  }
  if (pageSize < 1) {
    throw new Error('PageSize must be greater than or equal to 1');
  }

  const startIndex = page * pageSize;
  const endIndex = startIndex + pageSize;
  const paginatedItems = items.slice(startIndex, endIndex);

  return {
    items: paginatedItems,
    total: items.length,
    page,
    pageSize,
    totalPages: Math.ceil(items.length / pageSize),
  };
}
