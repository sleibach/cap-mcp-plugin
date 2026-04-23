using {sap.capire.bookshop as my} from '../db/schema';

service AdminService {
  entity Authors    as projection on my.Authors;
  entity Books      as projection on my.Books;
  entity Genres     as projection on my.Genres;
  entity Orders     as projection on my.Orders;
  entity OrderItems as projection on my.OrderItems;
}
