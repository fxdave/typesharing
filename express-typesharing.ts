import { z, ZodError, ZodType } from "zod";
import { Request, Response, Express, response } from "express";
import {
  ImprovedZodIssue,
  unexpectedError,
  zodValidationError,
} from "./express-typesharing-responses";

type ExpressRequest = Request; // TODO
type ExpressResponse = Response; // TODO
type MiddlewareProps<TData> = {
  data: TData;
  req: ExpressRequest;
  res: ExpressResponse;
};
type Middleware<TData, TResult> = (
  props: MiddlewareProps<TData>
) => Promise<TResult & ({ next: true } | { next: false; statusCode: number })>;
/** The last middleware */
type Finalware<TData, TResult> = (
  props: MiddlewareProps<TData>
) => Promise<TResult>;
type Endpoint<TRequest, TResponse> = (
  req: ExpressRequest,
  res: ExpressResponse
) => Promise<{
  statusCode: number;
  data: TResponse;
}> & { _phantomData?: { request: TRequest; response: TResponse } };

/** Middlewares should include next, which tells the handler to continue */
type Next = { next: true | false };
type HttpVerbs = "get" | "post" | "put" | "patch" | "delete";
const getBuilder = <A = unknown, Response = never>(config: {
  app: Express;
  middlewares: Middleware<any, any>[];
  finalware?: Finalware<any, any>;
  method?: HttpVerbs;
  path?: string;
}) => {
  function buildFinalMiddlewareSetter(method: HttpVerbs) {
    return <B extends A, C>(
      mw: Finalware<B & { next: true }, C | Response>
    ) => {
      return getBuilder<B & { next: true }, Response | C>({
        ...config,
        finalware: mw,
        method,
      });
    };
  }

  function setMiddleware<C extends Next>(mw: Middleware<A, C>) {
    return getBuilder<A & C & { next: true }, (C & { next: false }) | Response>(
      {
        ...config,
        middlewares: [...config.middlewares, mw],
      }
    );
  }

  const getSchemaMiddleware =
    <
      PropertyName extends keyof ExpressRequest,
      TParser extends ZodType<any, any, any>
    >(
      propertyName: PropertyName,
      parser: TParser
    ) =>
    async ({ req }: { req: ExpressRequest }) => {
      try {
        return {
          [propertyName]: parser.parse(req[propertyName]) as z.infer<TParser>,
          next: true as const,
        };
      } catch (e) {
        if (e instanceof ZodError) {
          return {
            ...zodValidationError(e.issues as ImprovedZodIssue<any>[]),
            next: false as const,
          };
        }
        return {
          ...unexpectedError(),
          next: false as const,
        };
      }
    };

  type SchemaMiddlewareResponse<
    PropertyName extends keyof ExpressRequest,
    TParser extends ZodType<any, any, any>
  > = Awaited<
    ReturnType<ReturnType<typeof getSchemaMiddleware<PropertyName, TParser>>>
  >;

  function buildMiddleware() {
    return (async <TData>({
      req,
      res,
      data,
    }: {
      req: ExpressRequest;
      res: ExpressResponse;
      data: TData;
    }) => {
      let actualData = data;
      for (let mw of config.middlewares) {
        const { next, ...rest } = await mw({ data: actualData, req, res });
        if (typeof next !== "boolean") throw new BadMiddlewareReturnTypeError();
        if (!next) return { ...rest, next: false };
        actualData = { ...actualData, ...rest };
      }
      return { ...actualData, next: true };
    }) as Middleware<null, Response>;
  }

  return {
    bodySchema<TParser extends ZodType<any, any, any>>(bodyParser: TParser) {
      return getBuilder<
        A & SchemaMiddlewareResponse<"body", TParser> & { next: true },
        (SchemaMiddlewareResponse<"body", TParser> & { next: false }) | Response
      >({
        ...config,
        middlewares: [
          ...config.middlewares,
          getSchemaMiddleware("body", bodyParser),
        ],
      });
    },
    querySchema<TParser extends ZodType<any, any, any>>(queryParser: TParser) {
      return getBuilder<
        A & SchemaMiddlewareResponse<"query", TParser> & { next: true },
        | (SchemaMiddlewareResponse<"query", TParser> & { next: false })
        | Response
      >({
        ...config,
        middlewares: [
          ...config.middlewares,
          getSchemaMiddleware("query", queryParser),
        ],
      });
    },
    middleware: setMiddleware,
    get: buildFinalMiddlewareSetter("get"),
    post: buildFinalMiddlewareSetter("post"),
    patch: buildFinalMiddlewareSetter("patch"),
    delete: buildFinalMiddlewareSetter("delete"),
    put: buildFinalMiddlewareSetter("put"),
    path(path: string) {
      return getBuilder<A, Response>({ ...config, path });
    },
    chain<TReq, TRes>(mw: Middleware<TReq, TRes>) {
      return getBuilder<
        TReq & { next: true },
        (TRes & { next: false }) | Response
      >({
        ...config,
        middlewares: [...config.middlewares, mw],
      });
    },

    buildLink(): Middleware<null, Response> {
      return buildMiddleware();
    },

    build(): Endpoint<A, Response> {
      const endpoint = buildMiddleware();

      if (!config.method) {
        throw new Error("Path is required");
      }
      if (!config.path) {
        throw new Error("Path is required");
      }

      return config.app[config.method](config.path, (req, res) => {
        endpoint({ req, res, data: null })
          .then((response) => {
            if (typeof response.next !== "boolean")
              throw new BadMiddlewareReturnTypeError();

            if (!response.next) {
              return response;
            }

            if (!config.finalware) {
              throw new MissingFinalMiddlewareError();
            }
            return config.finalware({ req, res, data: response });
          })
          .then((response) => {
            const { next, statusCode, ...rest } = response;
            res.status(statusCode).send(rest);
          })
          .catch((err) => {
            console.error(err);

            res.status(500).send({
              message: "Something went wrong.",
            });
          });
      });
    },
  };
};

export const createBuilder = (app: Express) =>
  getBuilder({
    app,
    middlewares: [],
  });

class BadMiddlewareReturnTypeError extends Error {
  constructor() {
    super(
      'Every middleware should return an object with a "next" bool attribute'
    );
  }
}
class MissingFinalMiddlewareError extends Error {
  constructor() {
    super(
      "You have to use get/put/delete/post/patch at the end of the middleware chain"
    );
  }
}
