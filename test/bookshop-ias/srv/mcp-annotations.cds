using {CatalogService} from './cat-service';
using {AdminService}   from './admin-service';

// ---------------------------------------------------------------------------
// CatalogService (read-only surface for end users)
// ---------------------------------------------------------------------------

annotate CatalogService.Books with @mcp: {
  name       : 'books',
  description: 'Book catalog — filterable, sortable, paginated',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};

annotate CatalogService.Books with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get'],
  hint : 'Use for read-only lookups of books by id, title, author or genre'
};

annotate CatalogService.ListOfBooks with @mcp: {
  name       : 'list-of-books',
  description: 'Flattened list of books with genre and currency symbol resolved',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};

annotate CatalogService.submitOrder with @mcp: {
  name       : 'submit-order',
  description: 'Place an order for a book; returns the updated stock level',
  tool       : true
};

// ---------------------------------------------------------------------------
// AdminService (full CRUD surface — requires @requires:'admin')
// ---------------------------------------------------------------------------

annotate AdminService.Authors with @mcp: {
  name       : 'admin-authors',
  description: 'Book authors — manage the author catalog',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};

annotate AdminService.Authors with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update', 'delete'],
  hint : {
    query : 'Search authors by name, place of birth, or life dates',
    get   : 'Fetch a single author by its integer ID',
    create: 'Create a new author. Name is mandatory; other fields optional',
    update: 'Update an author by ID. Provide only the fields you want to change',
    delete: 'Delete an author by ID. Fails if the author still has books'
  }
};

annotate AdminService.Books with @mcp: {
  name       : 'admin-books',
  description: 'Book entries — manage the book catalog (stock, price, assignments)',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};

annotate AdminService.Books with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update', 'delete'],
  hint : {
    query : 'Find books by title, author_ID, genre_ID, stock level or price',
    get   : 'Fetch a single book by its integer ID',
    create: 'Create a new book. Always pass author_ID (FK); title is mandatory',
    update: 'Update a book by ID — typical use: adjust stock or price',
    delete: 'Delete a book by ID. Irreversible; prefer setting stock to 0 first'
  }
};

// Field-level hints — surfaced as part of the tool description so the LLM
// picks FK fields over association names and understands business rules.
annotate AdminService.Books with {
  author   @mcp.hint: 'Association to Authors — use author_ID (integer) in filters and writes';
  genre    @mcp.hint: 'Association to Genres — use genre_ID (UUID string) in filters and writes';
  stock    @mcp.hint: 'Units currently on hand. Non-negative integer';
  price    @mcp.hint: 'Unit price in the books currency. Decimal(9,2)';
  currency @mcp.hint: 'ISO currency code (e.g. EUR, USD) — use currency_code in writes';
};

annotate AdminService.Genres with @mcp: {
  name       : 'admin-genres',
  description: 'Genre taxonomy — manage the hierarchical genre code list',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};

// Genres are rarely edited once created, so we expose CRD but not update
// (deliberate partial mode selection to exercise the filtering logic).
annotate AdminService.Genres with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'delete'],
  hint : {
    query : 'Browse genres, including parent/child hierarchy via parent_ID',
    get   : 'Fetch a single genre by its UUID',
    create: 'Create a new genre. Name + descr; parent_ID to nest under another genre',
    delete: 'Delete a genre by UUID. Fails if still referenced by books or children'
  }
};

// ---------------------------------------------------------------------------
// Orders — parent-child schema (Composition of many OrderItems).
// Draft-enabled on the projection. Tests deep insert of a nested
// composition via the parent draft flow, which is the real-world
// Fiori-elements pattern every CAP project with sub-tables hits.
// ---------------------------------------------------------------------------
annotate AdminService.Orders with @mcp: {
  name       : 'admin-orders',
  description: 'Customer orders with nested line items (draft-enabled)',
  resource   : ['filter', 'orderby', 'select', 'top', 'skip']
};

annotate AdminService.Orders with @mcp.wrap: {
  tools: true,
  modes: ['query', 'get', 'create', 'update', 'delete'],
  hint : {
    query              : 'List orders — filter by status, customerName, orderNo or total',
    get                : 'Fetch a single order by its UUID, including the nested items composition',
    ![draft-new]       : 'Create a new order draft. orderNo + customerName mandatory; pass items=[{book_ID, quantity, price}] for deep insert of line items',
    ![draft-edit]      : 'Edit an existing active order by ID. Returns a mutable draft copy; subsequent patches and the final draft-activate land on the active row',
    ![draft-patch]     : 'Patch the order draft — update header fields or line items. For nested composition edits supply items with their IDs; items you omit are preserved',
    ![draft-activate]  : 'Publish the order draft. Fails if mandatory fields (orderNo, customerName) or nested items are incomplete',
    ![draft-discard]   : 'Discard the order draft. Leaves the active row (if any) untouched'
  }
};

annotate AdminService.Orders with {
  status   @mcp.hint: 'Order status enum: open | submitted | fulfilled | cancelled. Default is open';
  currency @mcp.hint: 'ISO currency code for the total — use currency_code in writes';
  total    @mcp.hint: 'Gross total in the order currency. Decimal(11,2); typically derived from item amounts';
  items    @mcp.hint: 'Composition of OrderItems — deep-insertable on draft-new. Each item: {book_ID, quantity, price, amount?}';
};
