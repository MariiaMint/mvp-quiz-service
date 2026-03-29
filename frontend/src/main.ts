import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => {
    console.error(err);
    const host = document.querySelector('app-root');
    if (host) {
      host.innerHTML = '<pre style="padding:16px;color:#b00020;white-space:pre-wrap;">Angular bootstrap error:\n' + String(err) + '</pre>';
    }
  });
