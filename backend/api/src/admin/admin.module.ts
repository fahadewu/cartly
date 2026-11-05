import { Module } from '@nestjs/common';
import { AdminCatalogController, AdminCatalogService } from './catalog.js';
import { AdminDashboardController, DashboardService } from './dashboard.js';
import { AdminPeopleController, AdminPeopleService } from './people.js';
import { AdminOrdersController, AdminOrdersService, AdminPromosController, AdminPromosService } from './sales.js';
import { AdminImportController, ProductImportService } from './import.js';
import { AdminTryOnController } from './tryon.js';

/** Everything under /admin: admins only, role re-checked against the database per request. */
@Module({
  controllers: [AdminDashboardController, AdminCatalogController, AdminImportController, AdminTryOnController, AdminOrdersController, AdminPromosController, AdminPeopleController],
  providers: [DashboardService, AdminCatalogService, ProductImportService, AdminOrdersService, AdminPromosService, AdminPeopleService],
})
export class AdminModule {}
