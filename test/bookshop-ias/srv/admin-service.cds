using {sap.capire.bookshop as my} from '../db/schema';

service AdminService {
  @odata.draft.enabled
  entity Authors    as projection on my.Authors;
  @odata.draft.enabled
  entity Books      as projection on my.Books;
  @odata.draft.enabled
  entity Genres     as projection on my.Genres;
  @odata.draft.enabled
  entity Orders     as projection on my.Orders;
  entity OrderItems as projection on my.OrderItems;
}
