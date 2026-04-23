using {
  Currency,
  cuid,
  managed,
  sap
} from '@sap/cds/common';

namespace sap.capire.bookshop;

entity Books : managed {
  key ID       : Integer;
      author   : Association to Authors @mandatory;
      title    : localized String       @mandatory;
      descr    : localized String;
      genre    : Association to Genres;
      stock    : Integer;
      price    : Price;
      currency : Currency;
}

entity Authors : managed {
  key ID           : Integer;
      name         : String @mandatory;
      dateOfBirth  : Date;
      dateOfDeath  : Date;
      placeOfBirth : String;
      placeOfDeath : String;
      books        : Association to many Books
                       on books.author = $self;
}

/** Hierarchically organized Code List for Genres */
entity Genres : cuid, sap.common.CodeList {
  parent   : Association to Genres;
  children : Composition of many Genres
               on children.parent = $self;
}

type Price : Decimal(9, 2);

// --------------------------------------------------------------------------------
// Orders / OrderItems — realistic parent-child schema covering the
// parent-child pattern most CAP projects use. Uses cuid (UUID) for both
// roots so the draft lifecycle works without sequence collisions (see
// B-NEW-1); Integer keys on draft-enabled entities are a known footgun.
entity Orders : cuid, managed {
  orderNo      : String @mandatory;
  customerName : String @mandatory;
  status       : String enum {
    open;
    submitted;
    fulfilled;
    cancelled;
  } default 'open';
  notes        : String;
  total        : Decimal(11, 2);
  currency     : Currency;
  items        : Composition of many OrderItems
                   on items.parent = $self;
}

entity OrderItems : cuid {
  parent   : Association to Orders;
  book     : Association to Books;
  quantity : Integer @mandatory;
  price    : Decimal(9, 2);
  amount   : Decimal(11, 2);
}

// --------------------------------------------------------------------------------
// Temporary workaround for this situation:
// - Fiori apps in bookstore annotate Books with @fiori.draft.enabled.
// - Because of that .csv data has to eagerly fill in ID_texts column.
annotate Books with @fiori.draft.enabled;
