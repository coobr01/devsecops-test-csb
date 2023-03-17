import { StrictMode } from "react";
import { render } from "react-dom";
import reportWebVitals from "./reportWebVitals";
// ---
import { ContentProvider } from "contexts/content";
import { DialogProvider } from "contexts/dialog";
import { UserProvider } from "contexts/user";
import { CsbProvider } from "contexts/csb";
import { BapProvider } from "contexts/bap";
import { FormioSubmissionsProvider } from "contexts/formioSubmissions";
import { FormioFormProvider } from "contexts/formioForm";
import { NotificationsProvider } from "contexts/notifications";
import { ErrorBoundary } from "components/errorBoundary";
import { App } from "components/app";
import "./tailwind-preflight.css";
import "./styles.css";

const container = document.getElementById("root") as HTMLElement;

render(
  <StrictMode>
    <ErrorBoundary>
      <ContentProvider>
        <DialogProvider>
          <UserProvider>
            <CsbProvider>
              <BapProvider>
                <FormioSubmissionsProvider>
                  <FormioFormProvider>
                    <NotificationsProvider>
                      <App />
                    </NotificationsProvider>
                  </FormioFormProvider>
                </FormioSubmissionsProvider>
              </BapProvider>
            </CsbProvider>
          </UserProvider>
        </DialogProvider>
      </ContentProvider>
    </ErrorBoundary>
  </StrictMode>,
  container
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
