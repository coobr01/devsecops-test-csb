import { useMemo, useEffect, useState, useRef } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Formio, Form } from "@formio/react";
import { cloneDeep, isEqual } from "lodash";
import icons from "uswds/img/sprite.svg";
// ---
import { serverUrl, messages, getData, postData } from "../config";
import { getUserInfo } from "../utilities";
import {
  submissionNeedsEdits,
  useFetchedFormSubmissions,
  useCombinedSubmissions,
  useSortedRebates,
} from "routes/allRebates";
import { Loading } from "components/loading";
import { Message } from "components/message";
import { MarkdownContent } from "components/markdownContent";
import { useContentState } from "contexts/content";
import { useDialogDispatch } from "contexts/dialog";
import { useUserState } from "contexts/user";
import { useCsbState } from "contexts/csb";
import { useBapState } from "contexts/bap";
import { useFormioSubmissionsState } from "contexts/formioSubmissions";
import {
  FormioSubmissionData,
  FormioFetchedResponse,
  useFormioFormState,
  useFormioFormDispatch,
} from "contexts/formioForm";
import { useNotificationsDispatch } from "contexts/notifications";

export function ApplicationForm() {
  const { epaUserData } = useUserState();
  const email = epaUserData.status !== "success" ? "" : epaUserData.data.mail;

  /**
   * NOTE: The child component only uses the email from the `user` context, but
   * the `epaUserData.data` object includes an `exp` field that changes whenever
   * the JWT is refreshed. Since the user verification process `verifyUser()`
   * gets called from the parent `ProtectedRoute` component, we need to memoize
   * the email address (which won't change) to prevent the child component from
   * needlessly re-rendering.
   */
  return useMemo(() => {
    return <ApplicationFormContent email={email} />;
  }, [email]);
}

function ApplicationFormContent({ email }: { email: string }) {
  const navigate = useNavigate();
  const { mongoId } = useParams<"mongoId">(); // MongoDB ObjectId string
  const [searchParams] = useSearchParams();

  const { content } = useContentState();
  const { csbData } = useCsbState();
  const { samEntities, formSubmissions: bapFormSubmissions } = useBapState();
  const {
    applicationSubmissions: formioApplicationSubmissions,
    paymentRequestSubmissions: formioPaymentRequestSubmissions,
  } = useFormioSubmissionsState();
  const { formio } = useFormioFormState();
  const dialogDispatch = useDialogDispatch();
  const formioFormDispatch = useFormioFormDispatch();
  const notificationsDispatch = useNotificationsDispatch();

  // reset formio form state since it's used across pages
  useEffect(() => {
    formioFormDispatch({ type: "RESET_FORMIO_DATA" });
  }, [formioFormDispatch]);

  useFetchedFormSubmissions();

  const combinedRebates = useCombinedSubmissions();
  const sortedRebates = useSortedRebates(combinedRebates);

  // log combined 'sortedRebates' array if 'debug' search parameter exists
  useEffect(() => {
    if (searchParams.has("debug") && sortedRebates.length > 0) {
      console.log(sortedRebates);
    }
  }, [searchParams, sortedRebates]);

  // create ref to store when form is being submitted, so it can be referenced
  // in the Form component's `onSubmit` event prop, to prevent double submits
  const formIsBeingSubmitted = useRef(false);

  // set when form submission data is initially fetched, and then re-set each
  // time a successful update of the submission data is posted to forms.gov
  const [storedSubmissionData, setStoredSubmissionData] =
    useState<FormioSubmissionData>({});

  // create ref to storedSubmissionData, so the latest value can be referenced
  // in the Form component's `onNextPage` event prop
  const storedSubmissionDataRef = useRef<FormioSubmissionData>({});

  // initially empty, but will be set once the user attemts to submit the form
  // (both successfully and unsuccessfully). passed to the to the <Form />
  // component's submission prop, so the fields the user filled out will not be
  // lost if a submission update fails, so the user can attempt submitting again
  const [pendingSubmissionData, setPendingSubmissionData] =
    useState<FormioSubmissionData>({});

  useEffect(() => {
    formioFormDispatch({ type: "FETCH_FORMIO_DATA_REQUEST" });

    getData(`${serverUrl}/api/formio-application-submission/${mongoId}`)
      .then((res: FormioFetchedResponse) => {
        // set up s3 re-route to wrapper app
        const s3Provider = Formio.Providers.providers.storage.s3;
        Formio.Providers.providers.storage.s3 = function (formio: any) {
          const s3Formio = cloneDeep(formio);
          const comboKey = res.submission?.data.bap_hidden_entity_combo_key;
          s3Formio.formUrl = `${serverUrl}/api/s3/application/${mongoId}/${comboKey}`;
          return s3Provider(s3Formio);
        };

        const data = { ...res.submission?.data };

        // remove `ncesDataSource` and `ncesDataLookup` fields
        if (data.hasOwnProperty("ncesDataSource")) delete data.ncesDataSource;
        if (data.hasOwnProperty("ncesDataLookup")) delete data.ncesDataLookup;

        setStoredSubmissionData((_prevData) => {
          storedSubmissionDataRef.current = cloneDeep(data);
          return data;
        });

        formioFormDispatch({
          type: "FETCH_FORMIO_DATA_SUCCESS",
          payload: { data: res },
        });
      })
      .catch((err) => {
        formioFormDispatch({ type: "FETCH_FORMIO_DATA_FAILURE" });
      });
  }, [mongoId, formioFormDispatch]);

  if (formio.status === "idle") {
    return null;
  }

  if (formio.status === "pending") {
    return <Loading />;
  }

  const { userAccess, formSchema, submission } = formio.data;

  if (
    formio.status === "failure" ||
    !userAccess ||
    !formSchema ||
    !submission
  ) {
    const text = `The requested submission does not exist, or you do not have access. Please contact support if you believe this is a mistake.`;
    return <Message type="error" text={text} />;
  }

  if (
    email === "" ||
    csbData.status !== "success" ||
    samEntities.status !== "success"
  ) {
    return <Loading />;
  }

  if (
    bapFormSubmissions.status === "idle" ||
    bapFormSubmissions.status === "pending" ||
    formioApplicationSubmissions.status === "idle" ||
    formioApplicationSubmissions.status === "pending" ||
    formioPaymentRequestSubmissions.status === "idle" ||
    formioPaymentRequestSubmissions.status === "pending"
  ) {
    return <Loading />;
  }

  if (
    bapFormSubmissions.status === "failure" ||
    formioApplicationSubmissions.status === "failure" ||
    formioPaymentRequestSubmissions.status === "failure"
  ) {
    return <Message type="error" text={messages.formSubmissionsError} />;
  }

  const applicationFormOpen = csbData.data.submissionPeriodOpen.application;

  const rebate = sortedRebates.find((item) => {
    return item.application.formio._id === mongoId;
  });

  const applicationNeedsEdits = !rebate
    ? false
    : submissionNeedsEdits({
        formio: rebate.application.formio,
        bap: rebate.application.bap,
      });

  const applicationNeedsEditsAndPaymentRequestExists =
    applicationNeedsEdits && rebate?.paymentRequest.formio;

  // NOTE: If the Application form submission needs edits and there's a
  // corresponding Payment Request form submission, display a confirmation
  // dialog prompting the user to delete the Payment Request form submission,
  // as it's data will no longer valid when the Application form submission's
  // data is changed.
  if (applicationNeedsEditsAndPaymentRequestExists) {
    dialogDispatch({
      type: "DISPLAY_DIALOG",
      payload: {
        dismissable: true,
        heading: "Submission Edits Requested",
        description: (
          <>
            <p>
              This Application form submission has been opened at the request of
              the applicant to make edits, but before you can make edits, the
              associated Payment Request form submission needs to be deleted. If
              the request to make edits to your Application form submission was
              made in error, contact the Clean School Bus Program helpline at{" "}
              <a href="mailto:cleanschoolbus@epa.gov">cleanschoolbus@epa.gov</a>
              .
            </p>
            <p>
              If you’d like to view the Payment Request form submission before
              deletion, please close this dialog box, and you will be
              re-directed to the associated Payment Request form.
            </p>
            <p>
              To proceed with deleting the associated Payment Request form
              submission, please select the{" "}
              <strong>Delete Payment Request Form Submission</strong> button
              below, and the Payment Request form submission will be deleted.
              The Application form will then be open for editing.
            </p>

            <div className="usa-alert usa-alert--error" role="alert">
              <div className="usa-alert__body">
                <p className="usa-alert__text">
                  <strong>Please note:</strong> Once deleted, the Payment
                  Request form submission will be removed from your dashboard
                  and cannot be recovered.
                </p>
              </div>
            </div>
          </>
        ),
        confirmText: "Delete Payment Request Form Submission",
        confirmedAction: () => {
          const paymentRequest = rebate.paymentRequest.formio;

          if (!paymentRequest) {
            notificationsDispatch({
              type: "DISPLAY_NOTIFICATION",
              payload: {
                type: "error",
                body: (
                  <>
                    <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                      Error deleting Payment Request <em>{rebate.rebateId}</em>.
                    </p>
                    <p className="tw-mt-1 tw-text-sm tw-text-gray-500">
                      Please notify the helpdesk that a problem exists
                      preventing the deletion of Payment Request form submission{" "}
                      <em>{rebate.rebateId}</em>.
                    </p>
                  </>
                ),
              },
            });

            // NOTE: logging rebate for helpdesk debugging purposes
            console.log(rebate);
            return;
          }

          notificationsDispatch({
            type: "DISPLAY_NOTIFICATION",
            payload: {
              type: "info",
              body: (
                <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                  Deleting Payment Request <em>{rebate.rebateId}</em>...
                </p>
              ),
            },
          });

          postData(
            `${serverUrl}/api/delete-formio-payment-request-submission`,
            {
              mongoId: paymentRequest._id,
              rebateId: paymentRequest.data.hidden_bap_rebate_id,
              comboKey: paymentRequest.data.bap_hidden_entity_combo_key,
            }
          )
            .then((res) => {
              window.location.reload();
            })
            .catch((err) => {
              notificationsDispatch({
                type: "DISPLAY_NOTIFICATION",
                payload: {
                  type: "error",
                  body: (
                    <>
                      <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                        Error deleting Payment Request{" "}
                        <em>{rebate.rebateId}</em>.
                      </p>
                      <p className="tw-mt-1 tw-text-sm tw-text-gray-500">
                        Please reload the page to attempt the deletion again, or
                        contact the helpdesk if the problem persists.
                      </p>
                    </>
                  ),
                },
              });
            });
        },
        dismissedAction: () => navigate(`/payment-request/${rebate.rebateId}`),
      },
    });

    return null;
  }

  const formIsReadOnly =
    (submission.state === "submitted" || !applicationFormOpen) &&
    !applicationNeedsEdits;

  const entityComboKey = storedSubmissionData.bap_hidden_entity_combo_key;
  const entity = samEntities.data.entities.find((entity) => {
    return (
      entity.ENTITY_STATUS__c === "Active" &&
      entity.ENTITY_COMBO_KEY__c === entityComboKey
    );
  });

  // TODO: do we need to account for when ENTITY_STATUS__c does not equal "Active" (e.g. its expired)?
  if (!entity) return null;

  const { title, name } = getUserInfo(email, entity);

  return (
    <div className="margin-top-2">
      {content.status === "success" && (
        <MarkdownContent
          className="margin-top-4"
          children={
            submission.state === "draft"
              ? content.data?.draftApplicationIntro || ""
              : submission.state === "submitted"
              ? content.data?.submittedApplicationIntro || ""
              : ""
          }
        />
      )}

      <ul className="usa-icon-list">
        <li className="usa-icon-list__item">
          <div className="usa-icon-list__icon text-primary">
            <svg className="usa-icon" aria-hidden="true" role="img">
              <use href={`${icons}#local_offer`} />
            </svg>
          </div>
          <div className="usa-icon-list__content">
            <strong>Application ID:</strong> {submission._id}
          </div>
        </li>

        {rebate?.application.bap?.rebateId && (
          <li className="usa-icon-list__item">
            <div className="usa-icon-list__icon text-primary">
              <svg className="usa-icon" aria-hidden="true" role="img">
                <use href={`${icons}#local_offer`} />
              </svg>
            </div>
            <div className="usa-icon-list__content">
              <strong>Rebate ID:</strong> {rebate.application.bap.rebateId}
            </div>
          </li>
        )}
      </ul>

      <div className="csb-form">
        <Form
          form={formSchema.json}
          url={formSchema.url} // NOTE: used for file uploads
          submission={{
            data: {
              ...storedSubmissionData,
              last_updated_by: email,
              hidden_current_user_email: email,
              hidden_current_user_title: title,
              hidden_current_user_name: name,
              ...pendingSubmissionData,
            },
          }}
          options={{
            readOnly: formIsReadOnly,
            noAlerts: true,
          }}
          onSubmit={(onSubmitSubmission: {
            state: "submitted" | "draft";
            data: FormioSubmissionData;
            metadata: unknown;
          }) => {
            if (formIsReadOnly) return;

            // account for when form is being submitted to prevent double submits
            if (formIsBeingSubmitted.current) return;
            if (onSubmitSubmission.state === "submitted") {
              formIsBeingSubmitted.current = true;
            }

            const data = { ...onSubmitSubmission.data };

            // remove `ncesDataSource` and `ncesDataLookup` fields
            if (data.hasOwnProperty("ncesDataSource")) {
              delete data.ncesDataSource;
            }
            if (data.hasOwnProperty("ncesDataLookup")) {
              delete data.ncesDataLookup;
            }

            if (onSubmitSubmission.state === "submitted") {
              notificationsDispatch({
                type: "DISPLAY_NOTIFICATION",
                payload: {
                  type: "info",
                  body: (
                    <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                      Submitting...
                    </p>
                  ),
                },
              });
            }

            if (onSubmitSubmission.state === "draft") {
              notificationsDispatch({
                type: "DISPLAY_NOTIFICATION",
                payload: {
                  type: "info",
                  body: (
                    <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                      Saving draft...
                    </p>
                  ),
                },
              });
            }

            setPendingSubmissionData(data);

            postData(
              `${serverUrl}/api/formio-application-submission/${submission._id}`,
              { ...onSubmitSubmission, data }
            )
              .then((res) => {
                setStoredSubmissionData((_prevData) => {
                  storedSubmissionDataRef.current = cloneDeep(res.data);
                  return res.data;
                });

                setPendingSubmissionData({});

                if (onSubmitSubmission.state === "submitted") {
                  notificationsDispatch({
                    type: "DISPLAY_NOTIFICATION",
                    payload: {
                      type: "success",
                      body: (
                        <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                          Application Form <em>{mongoId}</em> submitted
                          successfully.
                        </p>
                      ),
                    },
                  });

                  navigate("/");
                }

                if (onSubmitSubmission.state === "draft") {
                  notificationsDispatch({
                    type: "DISPLAY_NOTIFICATION",
                    payload: {
                      type: "success",
                      body: (
                        <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                          Draft saved successfully.
                        </p>
                      ),
                    },
                  });

                  setTimeout(() => {
                    notificationsDispatch({ type: "DISMISS_NOTIFICATION" });
                  }, 5000);
                }
              })
              .catch((err) => {
                formIsBeingSubmitted.current = false;

                notificationsDispatch({
                  type: "DISPLAY_NOTIFICATION",
                  payload: {
                    type: "error",
                    body: (
                      <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                        {onSubmitSubmission.state === "submitted"
                          ? "Error submitting Application form."
                          : "Error saving draft."}
                      </p>
                    ),
                  },
                });
              });
          }}
          onNextPage={(onNextPageParam: {
            page: number;
            submission: {
              data: FormioSubmissionData;
              metadata: unknown;
            };
          }) => {
            if (formIsReadOnly) return;

            const data = { ...onNextPageParam.submission.data };

            // remove `ncesDataSource` and `ncesDataLookup` fields
            if (data.hasOwnProperty("ncesDataSource")) {
              delete data.ncesDataSource;
            }
            if (data.hasOwnProperty("ncesDataLookup")) {
              delete data.ncesDataLookup;
            }

            // don't post an update if no changes have been made to the form
            // (ignoring current user fields)
            const dataToCheck = { ...data };
            delete dataToCheck.hidden_current_user_email;
            delete dataToCheck.hidden_current_user_title;
            delete dataToCheck.hidden_current_user_name;
            const storedDataToCheck = { ...storedSubmissionDataRef.current };
            delete storedDataToCheck.hidden_current_user_email;
            delete storedDataToCheck.hidden_current_user_title;
            delete storedDataToCheck.hidden_current_user_name;
            if (isEqual(dataToCheck, storedDataToCheck)) return;

            notificationsDispatch({
              type: "DISPLAY_NOTIFICATION",
              payload: {
                type: "info",
                body: (
                  <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                    Saving draft...
                  </p>
                ),
              },
            });

            setPendingSubmissionData(data);

            postData(
              `${serverUrl}/api/formio-application-submission/${submission._id}`,
              { ...onNextPageParam.submission, data, state: "draft" }
            )
              .then((res) => {
                setStoredSubmissionData((_prevData) => {
                  storedSubmissionDataRef.current = cloneDeep(res.data);
                  return res.data;
                });

                setPendingSubmissionData({});

                notificationsDispatch({
                  type: "DISPLAY_NOTIFICATION",
                  payload: {
                    type: "success",
                    body: (
                      <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                        Draft saved successfully.
                      </p>
                    ),
                  },
                });

                setTimeout(() => {
                  notificationsDispatch({ type: "DISMISS_NOTIFICATION" });
                }, 5000);
              })
              .catch((err) => {
                notificationsDispatch({
                  type: "DISPLAY_NOTIFICATION",
                  payload: {
                    type: "error",
                    body: (
                      <p className="tw-text-sm tw-font-medium tw-text-gray-900">
                        Error saving draft.
                      </p>
                    ),
                  },
                });
              });
          }}
        />
      </div>
    </div>
  );
}
