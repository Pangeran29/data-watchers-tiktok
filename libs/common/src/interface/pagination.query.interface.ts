export interface IPagination {
  page?: number;
  limit?: number;

  /**
   * Get total record to skip based on current pagination option.
   * @example
   * ```
   * getSkip():number {
   *  return (this.page - 1) * this.limit;
   * }
   * ```
   */
  getSkip(): number;
}
