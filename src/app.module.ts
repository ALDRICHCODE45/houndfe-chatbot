import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AppConfigModule } from './config/config.module';

@Module({
  imports: [
    AppConfigModule.forRoot(),
    // Phase 2–8 feature modules are added in later work-unit commits
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
