import {
  Dispatch,
  ReactNode,
  createContext,
  useContext,
  useReducer,
} from "react";

type Props = {
  children: ReactNode;
};

type State = {
  dialogShown: boolean;
  dismissable: boolean;
  heading: string;
  description: ReactNode;
  confirmText: string;
  dismissText?: string;
  confirmedAction: () => void;
  dismissedAction?: () => void;
};

export type Action =
  | {
      type: "DISPLAY_DIALOG";
      payload: {
        dismissable: boolean;
        heading: string;
        description: ReactNode;
        confirmText: string;
        dismissText?: string;
        confirmedAction: () => void;
        dismissedAction?: () => void;
      };
    }
  | {
      type: "UPDATE_DIALOG_DESCRIPTION";
      payload: {
        description: ReactNode;
      };
    }
  | { type: "RESET_DIALOG" };

const StateContext = createContext<State | undefined>(undefined);
const DispatchContext = createContext<Dispatch<Action> | undefined>(undefined);

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "DISPLAY_DIALOG": {
      const {
        heading,
        description,
        confirmText,
        dismissText,
        dismissable,
        confirmedAction,
        dismissedAction,
      } = action.payload;

      return {
        dialogShown: true,
        dismissable,
        heading,
        description,
        confirmText,
        dismissText,
        confirmedAction,
        dismissedAction,
      };
    }

    case "UPDATE_DIALOG_DESCRIPTION": {
      const { description } = action.payload;
      return {
        ...state,
        description,
      };
    }

    case "RESET_DIALOG": {
      return {
        dialogShown: false,
        dismissable: true,
        heading: "",
        description: null,
        confirmText: "",
        dismissText: "",
        confirmedAction: () => {},
        dismissedAction: () => {},
      };
    }

    default: {
      const message = `Unhandled action type: ${action}`;
      throw new Error(message);
    }
  }
}

export function DialogProvider({ children }: Props) {
  const initialState: State = {
    dialogShown: false,
    dismissable: true,
    heading: "",
    description: null,
    confirmText: "",
    dismissText: "",
    confirmedAction: () => {},
    dismissedAction: () => {},
  };

  const [state, dispatch] = useReducer(reducer, initialState);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>
        {children}
      </DispatchContext.Provider>
    </StateContext.Provider>
  );
}

/**
 * Returns state stored in `DialogProvider` context component.
 */
export function useDialogState() {
  const context = useContext(StateContext);
  if (context === undefined) {
    const message = `useDialogState must be called within a DialogProvider`;
    throw new Error(message);
  }
  return context;
}

/**
 * Returns `dispatch` method for dispatching actions to update state stored in
 * `DialogProvider` context component.
 */
export function useDialogDispatch() {
  const context = useContext(DispatchContext);
  if (context === undefined) {
    const message = `useDialogDispatch must be used within a DialogProvider`;
    throw new Error(message);
  }
  return context;
}
