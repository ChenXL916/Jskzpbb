import { Module } from '@nestjs/common';
import {
  MakeupArtistDashboardController,
  ManagementController,
  NotificationController,
  ProductAdminController,
  RiskCenterController
} from './product-operations.controller';
import { ProductOperationsService } from './product-operations.service';
import { RiskEngineService } from './risk-engine.service';

@Module({
  controllers: [
    ProductAdminController,
    ManagementController,
    MakeupArtistDashboardController,
    NotificationController,
    RiskCenterController
  ],
  providers: [ProductOperationsService, RiskEngineService],
  exports: [ProductOperationsService]
})
export class ProductOperationsModule {}
